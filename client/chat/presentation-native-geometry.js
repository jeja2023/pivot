(function () {
    'use strict';
    const identity = [1, 0, 0, 1, 0, 0];
    function multiply(a, b) {
        return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    }
    const translate = (x, y) => [1, 0, 0, 1, x, y];
    const scale = (x, y) => [x, 0, 0, y, 0, 0];
    const point = (matrix, x, y) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] });
    function scene(objects) {
        const result = new Map();
        for (const object of objects) {
            const frame = object.frame;
            if (!frame) continue;
            const parent = result.get(object.parentId)?.childMatrix || identity, angle = frame.rotation * Math.PI / 180;
            let own = multiply(translate(frame.x + frame.width / 2, frame.y + frame.height / 2), [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]);
            own = multiply(multiply(own, scale(frame.flipH ? -1 : 1, frame.flipV ? -1 : 1)), translate(-frame.width / 2, -frame.height / 2));
            const world = multiply(parent, own);
            const corners = [[0, 0], [frame.width, 0], [0, frame.height], [frame.width, frame.height]].map(([x, y]) => point(world, x, y));
            const minX = Math.min(...corners.map(item => item.x)), minY = Math.min(...corners.map(item => item.y));
            const child = object.childFrame;
            const childMatrix = child && child.width && child.height ? multiply(multiply(world, scale(frame.width / child.width, frame.height / child.height)), translate(-child.x, -child.y)) : world;
            result.set(object.id, { parent, childMatrix, x: minX, y: minY, width: Math.max(...corners.map(item => item.x)) - minX, height: Math.max(...corners.map(item => item.y)) - minY });
        }
        return result;
    }
    function localDelta(matrix, dx, dy) {
        const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
        if (Math.abs(determinant) < 1e-10) return { x: 0, y: 0 };
        return { x: (matrix[3] * dx - matrix[2] * dy) / determinant, y: (-matrix[1] * dx + matrix[0] * dy) / determinant };
    }
    window.Pivot.exposeModule('apps.presentations.nativeGeometry', { scene, localDelta });
})();
