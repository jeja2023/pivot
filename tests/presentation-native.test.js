'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../server/services/presentations/native/contract');
const { run } = require('../server/services/presentations/native/jobs');

test('原稿任务仅接受明确来源、版本与页面视频模式，不将静态视频标记为原生动画保真', () => {
    const documentId = 'native_' + 'a'.repeat(32);
    assert.equal(normalize({ sourceAssetId: '12' }).sourceAssetId, '12');
    assert.throws(() => normalize({ sourceAssetId: '12', sourceRenditionId: '1' }), /一个/);
    assert.throws(() => normalize({ sourceAssetId: '../../source' }), /来源/);
    assert.throws(() => normalize({ kind: 'patch', documentId, baseVersion: 0, patches: [] }), /版本/);
    assert.throws(() => normalize({ kind: 'video', documentId, baseVersion: 1 }), /页面视频/);
    const video = normalize({ kind: 'video', documentId, baseVersion: 1, mode: 'page_video', acknowledgeStatic: true, duration: 3, narration: [{ slideIndex: 0, assetId: '12' }] });
    assert.equal(video.video.duration, 3); assert.equal(video.video.resolution, '720p');
    assert.throws(() => normalize({ ...video, mode: 'page_video', acknowledgeStatic: true, narration: [{ slideIndex: 0, assetId: '12' }, { slideIndex: 0, assetId: '13' }] }), /重复/);
});

test('原稿对象补丁保留对象身份，拒绝非法页码与超量修改', () => {
    const request = { kind: 'patch', documentId: 'native_' + 'b'.repeat(32), baseVersion: 2, patches: [{ slideIndex: 0, objectId: '5', formulas: [{ index: 0, latex: '\\frac{x}{y}' }] }] };
    assert.equal(normalize(request).patches[0].objectId, '5');
    assert.throws(() => normalize({ ...request, patches: [{ slideIndex: 40, objectId: '5' }] }), /页码/);
    assert.throws(() => normalize({ ...request, patches: Array(201).fill(request.patches[0]) }), /200/);
});

function videoFixture(id, stop = false) {
    const state = { request: normalize({ kind: 'video', documentId: 'native_' + 'c'.repeat(32), baseVersion: 1, mode: 'page_video', acknowledgeStatic: true }), snapshot: { source: 'inputs/source.pptx', sourceDigest: 'source', narration: [] }, pageCount: 3, clips: [{ slideIndex: 0, duration: 1, narrated: false }] };
    const controller = new AbortController(), calls = []; let delivered = 0, cleaned = 0;
    const row = { id, status: 'working', expires_at: new Date(Date.now() + 600000).toISOString(), result_json: { state } };
    const repository = { claim: async (_user, _id, lease) => { row.result_json._lease = lease; row.result_json._leaseUntil = Date.now() / 1000 + 180; return true; }, readJob: async () => row,
        checkpoint: async (_user, _id, lease, next, progress) => { if (row.status !== 'working' || row.result_json._lease !== lease) return null; row.result_json.state = next; row.result_json.progress = progress; return row; }, release: async () => {}, withExecution: async (_user, _id, _lease, operation) => operation() };
    const store = { beginExecution: () => controller, endExecution() {}, complete: async (_id, _user, result, options) => { if (row.status === 'working' && row.result_json._lease === options.expectedLease) { row.status = options.failed ? 'failed' : 'completed'; row.result_json = result; } return { status: row.status }; } };
    const runtime = { execute: async (_user, _id, action) => {
        calls.push(action);
        if (stop) { row.status = 'cancelled'; controller.abort(); }
        return action.action === 'native_video_clip' ? { slideIndex: action.slideIndex, duration: 1, narrated: false } : { status: 'passed', outputDigest: 'video' };
    }, cleanupWorkspace: async () => { cleaned++; } };
    const storage = { access: async () => ({ tenantId: 1 }), deliver: async () => { delivered++; return { format: 'mp4' }; } };
    return { deps: { repository, store, runtime, storage }, row, calls, counts: () => ({ delivered, cleaned }) };
}

test('视频恢复保留已编码页，只继续剩余页面并完成受控交付', async () => {
    const fixture = videoFixture('resume-native'); await run({ id: 1 }, 'resume-native', fixture.deps);
    assert.deepEqual(fixture.calls.filter(action => action.action === 'native_video_clip').map(action => action.slideIndex), [1, 2]);
    assert.equal(fixture.calls.at(-1).action, 'native_video_finish'); assert.equal(fixture.row.status, 'completed');
    assert.equal(fixture.row.result_json.state.clips.length, 3); assert.deepEqual(fixture.counts(), { delivered: 1, cleaned: 1 });
});

test('视频取消在后续页面与交付前生效，不登记伪造完成文件', async () => {
    const fixture = videoFixture('cancel-native', true); await run({ id: 1 }, 'cancel-native', fixture.deps);
    assert.equal(fixture.row.status, 'cancelled'); assert.equal(fixture.calls.length, 1); assert.deepEqual(fixture.counts(), { delivered: 0, cleaned: 1 });
});

test('组合选择框和拖动坐标使用组合内部坐标，不把子对象当作整页坐标', () => {
    let geometry;
    require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../client/chat/presentation-native-geometry.js'), 'utf8'), { window: { Pivot: { exposeModule: (_name, api) => { geometry = api; } } } });
    const frame = (x, y, width, height, rotation = 0) => ({ x, y, width, height, rotation, flipH: false, flipV: false });
    const scene = geometry.scene([{ id: 'group', frame: frame(100, 50, 400, 200), childFrame: { x: 0, y: 0, width: 200, height: 100 } }, { id: 'child', parentId: 'group', frame: frame(20, 10, 30, 10) }]);
    const child = scene.get('child'); assert.equal(child.x, 140); assert.equal(child.y, 70); assert.equal(child.width, 60); assert.equal(child.height, 20);
    const delta = geometry.localDelta(child.parent, 20, 10); assert.equal(delta.x, 10); assert.equal(delta.y, 5);
});

test('离线视频沿用受控交付文件名，扩展名固定为MP4且不扩大旧桌面授权', () => {
    const paths = require('../server/services/agent-path-safety');
    assert.equal(paths.buildDeliveryFilename('../报告.exe', 'mp4'), '报告.mp4');
    assert.ok(!paths.LEGACY_DEFAULT_DELIVERY_FORMATS.includes('mp4'));
    assert.throws(() => paths.buildDeliveryFilename('报告', 'exe'), /不支持/);
});
