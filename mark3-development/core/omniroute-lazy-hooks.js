const omniRoute = require('../../core/omniroute');

const MARK = Symbol.for('ultron.mark3.lazy-omniroute-installed');

if (!omniRoute[MARK]) {
  const rawChat = omniRoute.chat.bind(omniRoute);
  const rawStreamChat = omniRoute.streamChat.bind(omniRoute);

  omniRoute.chat = async function mark3LazyOmniChat(options = {}) {
    const fallback = require('./omniroute-fallback');
    await fallback.ensure({ reason: `direct routes exhausted before ${options?.model || 'OmniRoute'} fallback` });
    return rawChat(options);
  };

  omniRoute.streamChat = async function mark3LazyOmniStream(options = {}) {
    const fallback = require('./omniroute-fallback');
    await fallback.ensure({ reason: `direct routes exhausted before ${options?.model || 'OmniRoute'} streaming fallback` });
    return rawStreamChat(options);
  };

  Object.defineProperty(omniRoute, MARK, { value: true, enumerable: false, configurable: false });
}

module.exports = omniRoute;
