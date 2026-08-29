export const SHORTCUT_RULE_ID = 1001;
export const SHORTCUT_PAGE = 'start.html';
export const PORTAL_URL = 'https://portal.uchicago.edu/ais/';
export const shortcutRule = () => ({
  id: SHORTCUT_RULE_ID, priority: 1,
  action: { type: 'redirect', redirect: { extensionPath: '/' + SHORTCUT_PAGE } },
  condition: { regexFilter: '^https?://my\\.uchicago\\.edu/(?:\\?&*)?$',
    resourceTypes: ['main_frame'], requestMethods: ['get'] }
});
