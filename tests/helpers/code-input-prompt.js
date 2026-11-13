'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parse5 = require('parse5');
const assert = require('node:assert/strict');

const fragment = parse5.parseFragment(fs.readFileSync(path.join(__dirname, '../../client/chat/partials/pre-app-modals.html'), 'utf8'));
const prompt = fragment.childNodes.find(node => node.attrs?.some(attr => attr.name === 'id' && attr.value === 'input-prompt-container'));
const inputPromptMarkup = parse5.serialize({ childNodes: [prompt] });

async function answerInputPrompt(page, value, expectedValue) {
    const field = page.locator('#input-prompt-field');
    await field.waitFor({ state: 'visible' });
    if (expectedValue !== undefined) assert.equal(await field.inputValue(), expectedValue);
    if (value === null) await page.locator('#modal-input-prompt-cancel').click();
    else {
        await field.fill(value);
        await page.locator('#modal-input-prompt-ok').click();
    }
}

module.exports = { inputPromptMarkup, answerInputPrompt };
