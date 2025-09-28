
function renderTifToDatas(raster, data) {
    if (raster.length === 2) {
        const pixelCount = raster[0].length;
        const dataLength = pixelCount * 4; // RGBA
        if (!data) {
            data = new Uint8Array(dataLength);
        }
        let dataIndex = 0;
        for (let pixelIndex = 0; pixelIndex < pixelCount; ++pixelIndex) {
            const u = raster[0][pixelIndex];
            const v = raster[1][pixelIndex];
            if (!isNaN(u) && !isNaN(v)) {
                const speed = Math.sqrt(u * u + v * v);
                const [r, g, b] = myColorMap(speed); // 用风速通过 myColorMap 获取颜色
                data[dataIndex++] = r;
                data[dataIndex++] = g;
                data[dataIndex++] = b;
                data[dataIndex++] = 255;
            } else {
                data[dataIndex++] = 0;
                data[dataIndex++] = 0;
                data[dataIndex++] = 0;
                data[dataIndex++] = 0;
            }
        }
        return data;
    }
}

// 自定义调色函数，根据原始值返回 [R,G,B]
function myColorMap(value) {
    const arr = rgbStringToArray(getColorForValue(value, windLegendDataValue, 10));
    if (arr.length === 3) return arr;
    // fallback
    if (value < 10) return [0, 0, 255];
    if (value < 50) return [0, 255, 0];
    return [255, 0, 0];
}

function rgbStringToArray(rgbStr) {
    // 匹配数字
    const matches = rgbStr.match(/\d+/g);

    // 转成数字数组
    return matches ? matches.map(Number) : [0, 0, 0];
}

function getColorForValue(value, colorMap, ration = 1, filterList = []) {
    if (colorMap.length === 0) return 'rgba(0,0,0)';
    if (filterList.includes(value)) return 'rgba(0,0,0)';

    const num = value / ration;

    let left = 0;
    let right = colorMap.length - 1;

    if (num < colorMap[0][0]) {
        return colorMap[0][1];
    }

    if (num >= colorMap[right][0]) {
        return colorMap[right][1];
    }

    while (left < right) {
        const mid = Math.floor((left + right) / 2);
        if (colorMap[mid][0] <= num && num < colorMap[mid + 1][0]) {
            const [startValue, startColor] = colorMap[mid];
            const [endValue, endColor] = colorMap[mid + 1];
            return Math.abs(num - startValue) <= Math.abs(num - endValue) ? startColor : endColor;
        } else if (num < colorMap[mid][0]) {
            right = mid - 1;
        } else {
            left = mid + 1;
        }
    }

    const [startValue, startColor] = colorMap[left];
    const [endValue, endColor] = colorMap[left + 1];
    return Math.abs(num - startValue) <= Math.abs(num - endValue) ? startColor : endColor;

}
const windLegendDataValue = [
    [0, 'rgb(97, 113, 184)'],
    [1, 'rgb(63, 110, 156)'],
    [2, 'rgb(67, 130, 167)'],
    [3, 'rgb(74, 148, 170)'],
    [4, 'rgb(75, 145, 147)'],
    [5, 'rgb(77, 142, 124)'],
    [6, 'rgb(78, 153, 102)'],
    [7, 'rgb(80, 165, 80)'],
    [8, 'rgb(87, 164, 71)'],
    [9, 'rgb(95, 164, 62)'],
    [10, 'rgb(103, 164, 54)'],
    [11, 'rgb(163, 158, 78)'],
    [12, 'rgb(161, 142, 69)'],
    [13, 'rgb(160, 126, 61)'],
    [14, 'rgb(161, 121, 68)'],
    [15, 'rgb(162, 109, 92)'],
    [16, 'rgb(142, 75, 83)'],
    [17, 'rgb(148, 72, 95)'],
    [18, 'rgb(154, 69, 108)'],
    [19, 'rgb(152, 72, 126)'],
    [20, 'rgb(151, 75, 145)'],
    [21, 'rgb(130, 84, 154)'],
    [22, 'rgb(110, 94, 164)'],
    [23, 'rgb(104, 99, 161)'],
    [24, 'rgb(99, 104, 158)'],
    [25, 'rgb(94, 109, 155)'],
    [26, 'rgb(89, 114, 152)'],
    [27, 'rgb(84, 119, 149)'],
    [28, 'rgb(79, 124, 147)'],
    [29, 'rgb(85, 130, 104)'],
    [30, 'rgb(91, 136, 61)']
];
