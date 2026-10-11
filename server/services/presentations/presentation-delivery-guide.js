'use strict';

function visibleText(slide = {}) {
    return (slide.elements || []).filter(element => element.visible !== false && element.type === 'text')
        .map(element => String(element.content?.text || '')).join(' ');
}

function slideTitle(slide = {}, index = 0) {
    const title = (slide.elements || []).filter(element => element.type === 'text')
        .sort((a, b) => Number(b.style?.fontSize || 0) - Number(a.style?.fontSize || 0))[0]?.content?.text;
    return String(title || `第 ${index + 1} 页`).slice(0, 120);
}

function buildPresentationDeliveryGuide(presentation = {}) {
    const slides = Array.isArray(presentation.slides) ? presentation.slides : [];
    const perSlide = slides.map((slide, index) => {
        const characters = visibleText(slide).replace(/\s/g, '').length;
        const seconds = Math.max(25, Math.min(150, Math.ceil(characters / 3.2)));
        const charts = (slide.elements || []).filter(element => element.type === 'chart');
        const questions = charts.map(chart => `“${chart.title || '该图表'}”的数据来源、统计口径和时间范围是什么？`);
        if (!questions.length && index > 0) questions.push(`“${slideTitle(slide, index)}”的执行负责人、时间点和风险预案是什么？`);
        return { slideId: slide.id, title: slideTitle(slide, index), seconds, questions: questions.slice(0, 2) };
    });
    const totalSeconds = perSlide.reduce((total, item) => total + item.seconds, 0);
    const questions = [...new Set(perSlide.flatMap(item => item.questions))].slice(0, 8);
    const backupSlides = slides.flatMap((slide, index) => (slide.elements || []).some(element => ['chart', 'table'].includes(element.type)) ? [{ slideId: slide.id, title: `${slideTitle(slide, index)} 数据口径与明细` }] : []);
    return {
        totalSeconds,
        estimatedMinutes: Math.max(1, Math.ceil(totalSeconds / 60)),
        perSlide,
        questions,
        backupSlides: backupSlides.slice(0, 8)
    };
}

module.exports = { buildPresentationDeliveryGuide };
