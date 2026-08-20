const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const SERVER_DIR = path.resolve(__dirname, '../server');
const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');

function findJsFiles(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
            if (['node_modules', '.git', 'coverage', 'dist', 'build'].includes(item.name)) continue;
            results = results.concat(findJsFiles(full));
        } else if (item.name.endsWith('.js')) {
            results.push(full);
        }
    }
    return results;
}

const allServerFiles = findJsFiles(SERVER_DIR);
const allScriptFiles = findJsFiles(SCRIPTS_DIR);
const targetFiles = [...allServerFiles, ...allScriptFiles];

console.log(`Scanning ${targetFiles.length} files across server/ and scripts/...`);

// Known DB and Async primitives
const DB_PRIMITIVES = new Set([
    'queryOne', 'query', 'execute', 'transaction', 'withTransaction',
    'queryOneAsync', 'queryAsync', 'executeAsync'
]);

const DB_OBJECT_METHODS = new Set([
    'queryOne', 'query', 'execute', 'transaction', 'withTransaction',
    'listWorkflowsForUser', 'getWorkflowVersionContext', 'getWorkflowVersionById',
    'createWorkflow', 'updateWorkflow', 'deleteWorkflow',
    'listRunsForUser', 'getRunById', 'createRun', 'updateRun',
    'updateAgentRunTitleAndGoal', 'softDeleteRun', 'deleteRun', 'getRunStatsForUser'
]);

// AST recursive walker
function walkAst(node, parent, visitor) {
    if (!node || typeof node !== 'object') return;
    node.parent = parent;
    visitor(node, parent);
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && c.type) {
                    walkAst(c, node, visitor);
                }
            }
        } else if (child && typeof child === 'object' && child.type) {
            walkAst(child, node, visitor);
        }
    }
}

// Pass 1: Collect all async functions and methods defined across the codebase
const asyncFunctions = new Map(); // function name -> Set of filePaths
const asyncMethods = new Set(); // method names

for (const filePath of targetFiles) {
    const code = fs.readFileSync(filePath, 'utf8');
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true, sourceType: 'script' });
    } catch (err) {
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true, sourceType: 'module' });
        } catch (err2) {
            console.error(`Failed to parse ${filePath}: ${err2.message}`);
            continue;
        }
    }

    walkAst(ast, null, (node, _parent) => {
        if (node.type === 'FunctionDeclaration' && node.async && node.id?.name) {
            if (!asyncFunctions.has(node.id.name)) asyncFunctions.set(node.id.name, new Set());
            asyncFunctions.get(node.id.name).add(filePath);
        } else if (node.type === 'VariableDeclarator' && node.id?.name) {
            if (node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') && node.init.async) {
                if (!asyncFunctions.has(node.id.name)) asyncFunctions.set(node.id.name, new Set());
                asyncFunctions.get(node.id.name).add(filePath);
            }
        } else if (node.type === 'Property' && node.value && (node.value.type === 'ArrowFunctionExpression' || node.value.type === 'FunctionExpression') && node.value.async) {
            if (node.key?.name) {
                asyncMethods.add(node.key.name);
                if (!asyncFunctions.has(node.key.name)) asyncFunctions.set(node.key.name, new Set());
                asyncFunctions.get(node.key.name).add(filePath);
            }
        } else if (node.type === 'MethodDefinition' && node.value?.async && node.key?.name) {
            asyncMethods.add(node.key.name);
            if (!asyncFunctions.has(node.key.name)) asyncFunctions.set(node.key.name, new Set());
            asyncFunctions.get(node.key.name).add(filePath);
        }
    });
}

console.log(`Found ${asyncFunctions.size} async functions/methods across codebase.`);

// Pass 2: Check all CallExpressions
const findings = [];

function isAwaitedOrHandled(node) {
    let curr = node;
    while (curr && curr.parent) {
        const p = curr.parent;
        if (p.type === 'AwaitExpression') return true;
        if (p.type === 'ReturnStatement') return true;
        if (p.type === 'ArrowFunctionExpression' && p.body === curr) return true; // implicit return
        
        // Inside Promise.all, Promise.allSettled, Promise.race
        if (p.type === 'ArrayExpression' && p.parent && p.parent.type === 'CallExpression') {
            const callee = p.parent.callee;
            if (callee && callee.type === 'MemberExpression' && callee.object?.name === 'Promise') {
                return true;
            }
        }
        
        // Chained with .then, .catch, .finally
        if (p.type === 'MemberExpression' && p.object === curr && (p.property?.name === 'then' || p.property?.name === 'catch' || p.property?.name === 'finally')) {
            return true;
        }

        // Passed into setImmediate, setTimeout, setInterval, asyncHandler, logAction
        if (p.type === 'CallExpression' && p.callee) {
            const calleeName = p.callee.name || p.callee.property?.name;
            if (['setImmediate', 'setTimeout', 'setInterval', 'asyncHandler', 'on', 'addEventListener', 'logAction'].includes(calleeName)) {
                return true;
            }
        }

        // Yield expression
        if (p.type === 'YieldExpression') return true;

        curr = p;
    }
    return false;
}

for (const filePath of targetFiles) {
    // Skip this script itself
    if (filePath.endsWith('check_async_db_calls.js')) continue;

    const code = fs.readFileSync(filePath, 'utf8');
    const lines = code.split('\n');
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true, sourceType: 'script' });
    } catch (err) {
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true, sourceType: 'module' });
        } catch (err2) {
            continue;
        }
    }

    walkAst(ast, null, (node, _parent) => {
        if (node.type !== 'CallExpression') return;

        let calleeName = null;
        let isDbPrimitive = false;
        let isDbObjectMethod = false;
        let isKnownAsync = false;

        if (node.callee.type === 'Identifier') {
            calleeName = node.callee.name;
            if (DB_PRIMITIVES.has(calleeName)) isDbPrimitive = true;
            if (asyncFunctions.has(calleeName)) isKnownAsync = true;
        } else if (node.callee.type === 'MemberExpression') {
            const propName = node.callee.property?.name;
            calleeName = propName;
            if (DB_OBJECT_METHODS.has(propName)) isDbObjectMethod = true;
            if (asyncMethods.has(propName)) isKnownAsync = true;
            if (asyncFunctions.has(propName)) isKnownAsync = true;
        }

        if (isDbPrimitive || isDbObjectMethod || isKnownAsync) {
            if (!isAwaitedOrHandled(node)) {
                const loc = node.loc.start;
                const lineContent = lines[loc.line - 1] ? lines[loc.line - 1].trim() : '';
                
                // Skip if this is a factory or definition e.g. createAgentNotificationFactory(...)
                if (calleeName && calleeName.startsWith('create') && calleeName.endsWith('Factory')) return;
                // Skip logger calls e.g. logger.info(...)
                if (node.callee.type === 'MemberExpression' && node.callee.object?.name === 'logger') return;
                if (node.callee.type === 'MemberExpression' && node.callee.object?.name === 'console') return;

                findings.push({
                    file: path.relative(path.resolve(__dirname, '..'), filePath),
                    line: loc.line,
                    column: loc.column,
                    callee: calleeName,
                    type: isDbPrimitive ? 'DB_PRIMITIVE' : (isDbObjectMethod ? 'DB_METHOD' : 'ASYNC_FUNCTION'),
                    code: lineContent
                });
            }
        }
    });
}

console.log(`\n=== SCAN COMPLETE: Found ${findings.length} unawaited async/DB calls ===\n`);

const grouped = {};
for (const f of findings) {
    if (!grouped[f.file]) grouped[f.file] = [];
    grouped[f.file].push(f);
}

for (const [file, items] of Object.entries(grouped)) {
    console.log(`\n📁 ${file} (${items.length} items):`);
    for (const item of items) {
        console.log(`  L${item.line}:${item.column} [${item.type}] ${item.callee} -> ${item.code}`);
    }
}
