// 仅编译首版使用的插件，避免引入富文本、公式和实时协作运行时。
import MindMap from 'simple-mind-map/index.js';
import Drag from 'simple-mind-map/src/plugins/Drag.js';
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation.js';
import Export from 'simple-mind-map/src/plugins/Export.js';
import Select from 'simple-mind-map/src/plugins/Select.js';
import AssociativeLine from 'simple-mind-map/src/plugins/AssociativeLine.js';
import TouchEvent from 'simple-mind-map/src/plugins/TouchEvent.js';
import Search from 'simple-mind-map/src/plugins/Search.js';
import MiniMap from 'simple-mind-map/src/plugins/MiniMap.js';
import './mindmap-text-layout.mjs';
MindMap.usePlugin(Drag).usePlugin(KeyboardNavigation).usePlugin(Export).usePlugin(Select).usePlugin(AssociativeLine).usePlugin(TouchEvent).usePlugin(Search).usePlugin(MiniMap);
export default class PivotMindMap extends MindMap {
    constructor(options) { super({ openPerformance: true, performanceConfig: { time: 100, padding: 100, removeNodeWhenOutCanvas: true }, ...options }); }
}
