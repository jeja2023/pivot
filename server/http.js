/* HTTP 工具模块 HTTP Utilities */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
