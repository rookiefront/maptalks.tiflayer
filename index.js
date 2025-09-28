import { TileLayer, Extent, Browser, registerWorkerAdapter, worker, Util } from 'maptalks';
import { Pool, fromUrl } from 'geotiff';
import SphericalMercator from '@mapbox/sphericalmercator';
import WORKERCODE from './src/worker/worker.bundle.js';
import { bboxCross, createCanvas, createImage, getBlankImage, mergeArrayBuffer } from './src/util.js';

const merc = new SphericalMercator({
    size: 256,
    antimeridian: true
});
const pool = new Pool();
const TEMPBBOX1 = [1, 1, 1, 1], TEMPBBOX2 = [1, 1, 1, 1];
const DEFAULT_TILE_SIZE = 512;
const workerKey = '_tifprocess_';
let tifActor;
let tempCanvas;

registerWorkerAdapter(workerKey, WORKERCODE);

function getActor() {
    if (tifActor) {
        return tifActor;
    }
    tifActor = new worker.Actor(workerKey);
    return tifActor;
}

function getTileImage(options) {
    if (!tempCanvas) {
        tempCanvas = createCanvas(DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE);
    }
    const ctx = tempCanvas.getContext('2d');
    const { width, height } = tempCanvas;
    ctx.clearRect(0, 0, width, height);
    const { bounds, image, quality } = options;
    const [px, py, w, h] = bounds;
    ctx.drawImage(image, px, py, w, h, 0, 0, width, height);
    if (!Browser.decodeImageInWorker) {
        const dataUrl = tempCanvas.toDataURL('image/png', quality || 0.6);
        return dataUrl;
    } else {
        const imageBitMap = tempCanvas.transferToImageBitmap();
        return imageBitMap;
    }
}
const forEachCoordinatesOfExtent = (extent, transform, out) => {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const coordinates = extent.toArray();
    coordinates.forEach(c => {
        c = c.toArray();
        c = merc[transform](c);
        const [x, y] = c;
        minx = Math.min(minx, x);
        miny = Math.min(miny, y);
        maxx = Math.max(maxx, x);
        maxy = Math.max(maxy, y);
    });
    if (out) {
        out.xmin = minx;
        out.ymin = miny;
        out.xmax = maxx;
        out.ymax = maxy;
        return out;
    }
    return [minx, miny, maxx, maxy];
};

const is4326 = (code) => {
    return code === 4326 || code === 4490;
};

const options = {
    urlTemplate: './hello?x={x}&y={y}&z={z}',
    datadebug: false,
    quality: 0.6,
    ignoreBlackColor: false,
    tileSize: DEFAULT_TILE_SIZE
};

export class TifLayer extends TileLayer {
    constructor(id, options) {
        super(id, options);
        this._pendingTiles = [];
        this.on('renderercreate', this._renderCreate);
        this.geoTifInfo = {
            loaded: false
        };
        this.renderTifToData = options.renderTifToData;
        if (!this.renderTifToData) {
            console.error('渲染方法必填');
        }
        this._initTif();
    }

    _renderCreate(e) {
        e.renderer.loadTile = function (tile) {
            let tileImage;
            if (Browser.decodeImageInWorker) {
                tileImage = {};
                // this._fetchImage(tileImage, tile);
            } else {
                const tileSize = this.layer.getTileSize(tile.layer);
                tileImage = new Image();

                tileImage.width = tileSize['width'];
                tileImage.height = tileSize['height'];

                tileImage.onload = this.onTileLoad.bind(this, tileImage, tile);
                tileImage.onerror = this.onTileError.bind(this, tileImage, tile);

                // this.loadTileImage(tileImage, tile['url'], tile);
            }
            this.loadTileImage(tileImage, tile['url'], tile);
            return tileImage;
        };
        e.renderer.loadTileImage = (img, url, tile) => {
            if (!this.geoTifInfo.loaded) {
                this._pendingTiles.push({
                    img, url, tile
                });
                return this;
            }
            setTimeout(() => {
                this._getTifTile({ url, img, tile });
            }, 1);

        };
    }

    _getTifTile(tileData) {
        // console.log(tileData);
        // return '';
        const { url, img, tile } = tileData;
        const searchParams = new URL(Util.getAbsoluteURL(url)).searchParams;
        function getParams(key) {
            return parseInt(searchParams.get(key));
        }
        const layer = this;
        const loadTile = (dataUrl) => {
            const reslove = (imageData) => {
                if (img instanceof Image) {
                    img.src = imageData;
                } else {
                    this.getRenderer().onTileLoad(imageData, tile);
                }
            };
            if (layer.customTileImage && Util.isFunction(layer.customTileImage)) {
                layer.customTileImage(dataUrl, tile, (bitMap) => {
                    reslove(bitMap);
                });
            } else {
                reslove(dataUrl);
            }

        };
        const x = getParams('x');
        const y = getParams('y');
        const z = getParams('z');
        const extent = this._getTileExtent(x, y, z);
        const map = this.getMap();
        const prj = map.getProjection();
        let bounds;
        if (prj.code.indexOf('4326') > -1) {
            bounds = this.geoTifInfo.bounds;
        } else if (prj.code.indexOf('3857') > -1) {
            bounds = this.geoTifInfo.mBounds;
        }
        if (!bounds) {
            console.error('onlay support 4326/3857 prj');
            return;
        }
        TEMPBBOX1[0] = extent.xmin;
        TEMPBBOX1[1] = extent.ymin;
        TEMPBBOX1[2] = extent.xmax;
        TEMPBBOX1[3] = extent.ymax;
        TEMPBBOX2[0] = bounds[0];
        TEMPBBOX2[1] = bounds[1];
        TEMPBBOX2[2] = bounds[2];
        TEMPBBOX2[3] = bounds[3];
        if (!bboxCross(TEMPBBOX1, TEMPBBOX2)) {
            const blank = getBlankImage();
            loadTile(blank);
            return null;
        }
        const tileBounds = this.getImageBounds(x, y, z, bounds);
        const dataUrl = getTileImage({
            bounds: tileBounds,
            image: this.geoTifInfo.canvas,
            quality: this.options.quality
        });
        loadTile(dataUrl);
    }

    _tifLoaded() {
        this._pendingTiles.forEach(tile => {
            this._getTifTile(tile);
        });
        return this;
    }

    _initTif() {
        const url = this.options.tifUrl;
        if (!url) {
            return this;
        }
        this.geoTifInfo = {
            url: url,
            loaded: false
        };
        fromUrl(url).then(tileHandle => {
            this.geoTifInfo.tileHandle = tileHandle;
            return tileHandle.getImage();
        }).then(async (image) => {
            const width = image.getWidth();
            const height = image.getHeight();
            let bounds = image.getBoundingBox();
            let mBounds = bounds;
            const geoInfo = image.getGeoKeys();
            this.geoTifInfo.imageTif = image;
            this.geoTifInfo.tileSize = this.getTileSize().width;
            this.geoTifInfo.geoInfo = geoInfo;
            const extent = new Extent(bounds);
            if (!geoInfo) {
                console.error('not find tif geo info');
                return;
            }
            if (is4326(geoInfo.GeographicTypeGeoKey)) {
                mBounds = forEachCoordinatesOfExtent(extent, 'forward');
            } else if (geoInfo.ProjectedCSTypeGeoKey === 3857) {
                bounds = forEachCoordinatesOfExtent(extent, 'inverse');
                forEachCoordinatesOfExtent(extent, 'inverse', extent);
            } else {
                console.error('Current coordinate projection not supported ', geoInfo);
            }
            this.geoTifInfo = Object.assign(this.geoTifInfo, {
                width, height, bounds, extent, mBounds
            });
            this.geoTifInfo.tileHandle.getImage();
            this.readTif(image);
        }).catch(error => {
            console.log(error);
        });
    }

    readTif(image) {

        const width = image.getWidth();
        const height = image.getHeight();
        const geoTifInfo = this.geoTifInfo;
        const readEnd = (image) => {
            geoTifInfo.loaded = true;
            geoTifInfo.canvas = image;
            this.fire('tifload', Object.assign({}, this.geoTifInfo));
            this._tifLoaded();
        };

        geoTifInfo.imageTif.readRasters({
            pool
        }).then(raster => {
            const datas = this.renderTifToData(raster);
            const cImage = createImage(width, height, datas, this.options.ignoreBlackColor);
            readEnd(cImage);
        });
    }

    getImageBounds(x, y, z, bounds) {
        const extent = this._getTileExtent(x, y, z);
        const tileminx = extent.xmin, tileminy = extent.ymin, tilemaxx = extent.xmax, tilemaxy = extent.ymax;
        const { width, height } = this.geoTifInfo;
        const [minx, miny, maxx, maxy] = bounds;
        const ax = width / (maxx - minx), ay = height / (maxy - miny);
        const px = (tileminx - minx) * ax, py = height - (tilemaxy - miny) * ay;
        let w = (tilemaxx - tileminx) * ax, h = (tilemaxy - tileminy) * ay;
        if (w === 0) {
            w = 0.1;
        }
        if (h === 0) {
            h = 0.1;
        }
        return [px, py, w, h];

    }

    _getTileExtent(x, y, z) {
        const map = this.getMap(), res = map._getResolution(z), tileConfig = this._getTileConfig(), tileExtent = tileConfig.getTilePrjExtent(x, y, res);
        return tileExtent;
    }

    setTifUrl(url) {
        this.options.tifUrl = url;
        this.geoTifInfo = {};
        this._pendingTiles = [];
        this._initTif();
        this.getRenderer().clear();
        this.getRenderer().setToRedraw();
        return this;
    }
}
TifLayer.mergeOptions(options);
