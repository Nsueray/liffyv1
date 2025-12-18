function isValidUuid(id) {
  if (!id || typeof id !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

function buildValidateIdMiddleware(paramName, label) {
  return function validateId(req, res, next) {
    const value = req.params[paramName];

    if (!value || value === 'undefined' || value === 'null' || !isValidUuid(value)) {
      return res.status(400).json({
        error: `Invalid ${label} format`,
        details: `${label} must be a valid UUID, received: ${value}`
      });
    }

    next();
  };
}

const validateJobId = buildValidateIdMiddleware('id', 'job ID');
const validateResultId = buildValidateIdMiddleware('id', 'result ID');

module.exports = {
  isValidUuid,
  validateJobId,
  validateResultId
};
