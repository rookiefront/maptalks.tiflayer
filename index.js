import { TileLayer, Extent, Browser, registerWorkerAdapter, worker, Util } from 'maptalks';
import { Pool, fromUrl } from 'geotiff';
import SphericalMercator from '@mapbox/sphericalmercator';
import WORKERCODE from './src/worker/worker.bundle.js';
import { bboxCross, createCanvas, createImage, getBlankImage } from './src/util.js';

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


function workerCreateImage(width, height, datas, ignoreBlackColor, readEnd) {
    if (!Browser.decodeImageInWorker) {
        const image = createImage(width, height, datas, ignoreBlackColor);
        readEnd(image)
    } else {
        const actor = getActor();
        const arrayBuffer = this.geoTifInfo.data.buffer;
        actor.send({ width, height, type: 'createimage', url: this.geoTifInfo.url, buffer: arrayBuffer, ignoreBlackColor: this.options.ignoreBlackColor },
            [arrayBuffer], (err, message) => {
                if (err) {
                    console.error(err);
                    return;
                }
                readEnd(message.buffer);
            });
    }
}


function getTileImage(options) {
    if (!tempCanvas) {
        tempCanvas = createCanvas(DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE);
    }
    const ctx = tempCanvas.getContext('2d');
    const {
        width,
        height
    } = tempCanvas;
    ctx.clearRect(0, 0, width, height);
    const {
        bounds,
        image,
        quality
    } = options;
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

async function getTileImageByRemoteTif(options, geoTifInfo) {
    if (!tempCanvas) {
        tempCanvas = createCanvas(DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE);
    }
    const ctx = tempCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const { bounds, quality } = options;
    const [px, py, w, h] = bounds;
    const params = {
        window: [px, py, px+w, py+h],
        width: geoTifInfo.tileSize,
        height: geoTifInfo.tileSize,
        pool,
    }
    console.log(params)
    const raster = await options.tifImage.readRasters(params);

    const data = options.renderTifToData(raster);

    const imageData = new ImageData(new Uint8ClampedArray(data), geoTifInfo.tileSize, geoTifInfo.tileSize);
    ctx.putImageData(imageData, 0, 0);

    if (!Browser.decodeImageInWorker) {
        return tempCanvas.toDataURL('image/png', quality || 0.6);
    } else {
        return tempCanvas.transferToImageBitmap();
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
    signal = new AbortController()
    constructor(id, options) {
        super(id, options);
        this._pendingTiles = [];
        this.on('renderercreate', this._renderCreate);

        this.renderTifToData = options.renderTifToData;
        if (!this.renderTifToData) {
            console.error('渲染方法必填');
        }
        this.geoTifInfo = {
            loaded: false,
        };
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
                    img,
                    url,
                    tile
                });
                return this;
            }
            setTimeout(() => {
                this._getTifTile({
                    url,
                    img,
                    tile
                });
            }, 1);

        };
    }

    _getTifTile(tileData) {
        const {
            url,
            img,
            tile
        } = tileData;
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
        // if (!this.geoTifInfo.loadedPreview){
            const dataUrl = getTileImage({
                bounds: tileBounds,
                image: this.geoTifInfo.canvas,
                quality: this.options.quality,
            });
            loadTile(dataUrl);
        // }else {
        //     getTileImageByRemoteTif({
        //         bounds: tileBounds,
        //         image: this.geoTifInfo.canvas,
        //         quality: this.options.quality,
        //         tifImage: !this.geoTifInfo.loadedPreview ?  this.geoTifInfo.imageSmallTif : this.geoTifInfo.imageTif,
        //         renderTifToData: this.renderTifToData
        //     }, this.geoTifInfo).then((dataUrl) => {
        //         loadTile(dataUrl);
        //     })
        // }

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
        fromUrl(url).then(async (tileHandle) => {
            this.geoTifInfo.tileHandle = tileHandle;
            const image = await tileHandle.getImage();
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
                width,
                height,
                bounds,
                extent,
                mBounds
            });
            let imageCount;
            try {
                imageCount = await tileHandle.getImageCount();
            } catch (e) {
                imageCount = 1;
            }
            // 加载最小的 image
            const smallImage = await tileHandle.getImage(imageCount - 1);
            this.geoTifInfo.imageSmallTif = smallImage;
            this.readTif(smallImage);
            return smallImage;
        }).catch(error => {
            console.log(error);
        });
    }

    async readTif() {
        const {
            width,
            height
        } = this.geoTifInfo;
        const geoTifInfo = this.geoTifInfo;
        const readEnd = (image) => {
            geoTifInfo.loaded = true;
            geoTifInfo.canvas = image;
            this.fire('tifload', Object.assign({}, this.geoTifInfo));
            this._tifLoaded();
        };
        await geoTifInfo.imageSmallTif.readRasters({
            pool,
            width,
            height
        }).then(raster => {
            const datas = this.renderTifToData(raster);
             workerCreateImage(width, height, datas, this.options.ignoreBlackColor, (cImage) => {
                 readEnd(cImage);
             });
        });
        // 渲染完成，清除缓存，进行移动加载大图
        this.once('renderend', () => {
            // 直接调用 clear 即可
            this.geoTifInfo.loadedPreview = true
            this.geoTifInfo.imageTif.readRasters({
                pool,
                width,
                height,
                signal: this.signal?.signal
            }).then((raster) => {
                const datas = this.renderTifToData(raster);
                workerCreateImage(width, height, datas, this.options.ignoreBlackColor, (cImage) => {
                    geoTifInfo.canvas = cImage;
                    const renderer = this.getRenderer()
                    if (renderer && renderer.tileInfoCache){
                        renderer.tileInfoCache.reset();
                    }
                });
            })

        })
    }

    getImageBounds(x, y, z, bounds) {
        const extent = this._getTileExtent(x, y, z);
        const tileminx = extent.xmin, tileminy = extent.ymin, tilemaxx = extent.xmax, tilemaxy = extent.ymax;
        const {
            width,
            height
        } = this.geoTifInfo;
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
        const map = this.getMap(), res = map._getResolution(z), tileConfig = this._getTileConfig(),
            tileExtent = tileConfig.getTilePrjExtent(x, y, res);
        return tileExtent;
    }


    setTifUrl(url) {
        this.signal?.abort?.()
        this.signal = new AbortController()
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
