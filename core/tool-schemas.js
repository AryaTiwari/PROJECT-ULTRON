module.exports = {
  object(properties = {}, required = []) {
    return { type: 'object', properties, required, additionalProperties: false };
  },
  string(description) { return { type: 'string', description }; },
  boolean(description) { return { type: 'boolean', description }; },
};
