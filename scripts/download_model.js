// 该脚本专用于 Docker 构建阶段，用于提前下载 RAG 向量模型并打包进镜像
const path = require('path');
const fs = require('fs');

async function downloadModel() {
    console.log('🔄 正在为 Docker 镜像离线打包下载向量模型...');
    
    // 动态引入 transformers
    const { pipeline, env } = await import('@xenova/transformers');
    
    // 构建时临时开启远程下载
    env.allowRemoteModels = true;
    
    // 将模型下载并缓存在我们指定的离线目录
    env.localModelPath = path.join(__dirname, '../models');
    
    try {
        console.log('⏳ 开始下载 Xenova/paraphrase-multilingual-MiniLM-L12-v2...');
        const extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
            quantized: true,
            progress_callback: (info) => {
                if (info.status === 'progress') {
                    process.stdout.write(`\\r📦 下载进度 [${info.file}]: ${Math.round(info.progress)}%`);
                } else if (info.status === 'done') {
                    console.log(`\\n✅ [${info.file}] 下载完成`);
                }
            }
        });
        console.log('\\n🎉 离线模型打包成功！所有文件已就绪。');
        process.exit(0);
    } catch (e) {
        console.error('\\n❌ 模型下载失败:', e);
        process.exit(1);
    }
}

downloadModel();
