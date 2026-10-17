// Small curated lists written for BurnerCheck (not copied from any third-party list).
// Keep them short and conservative: a wrong "role" or "free provider" flag is a false positive.

/** Local parts that usually reach a shared inbox or a system mailbox rather than one person. */
export const ROLE_LOCALS = new Set([
  'abuse', 'accounting', 'accounts', 'admin', 'administrator', 'all', 'billing', 'careers', 'contact',
  'customercare', 'customerservice', 'customer-service', 'devnull', 'dns', 'do-not-reply', 'donotreply',
  'enquiries', 'enquiry', 'everyone', 'feedback', 'finance', 'ftp', 'hello', 'help', 'helpdesk',
  'hostmaster', 'hr', 'info', 'information', 'inquiries', 'inquiry', 'invoice', 'invoices', 'it', 'jobs',
  'legal', 'mailer-daemon', 'marketing', 'media', 'news', 'newsletter', 'no-reply', 'noreply', 'nobody',
  'null', 'office', 'operations', 'ops', 'orders', 'partners', 'payments', 'postmaster', 'press',
  'privacy', 'recruiting', 'recruitment', 'root', 'sales', 'security', 'service', 'services', 'staff',
  'support', 'sysadmin', 'team', 'tech', 'usenet', 'uucp', 'webmaster', 'www',
]);

/**
 * Consumer webmail / ISP mailbox domains (exact match only), including the regional domains the big
 * providers actually hand out.
 */
const regional = (base, endings) => endings.map((e) => `${base}.${e}`);
export const FREE_PROVIDERS = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  ...regional('outlook', ['com', 'at', 'be', 'cl', 'cz', 'de', 'dk', 'es', 'fr', 'hu', 'ie', 'in', 'it', 'jp', 'kr', 'lv',
    'my', 'ph', 'pt', 'sa', 'sg', 'sk', 'co.id', 'co.il', 'co.nz', 'co.th', 'com.ar', 'com.au', 'com.br', 'com.gr',
    'com.pe', 'com.tr', 'com.vn']),
  ...regional('hotmail', ['com', 'ca', 'co.uk', 'fr', 'de', 'it', 'es', 'be', 'nl', 'se', 'no', 'dk', 'fi', 'ch', 'at',
    'gr', 'co.jp', 'co.nz', 'co.za', 'com.au', 'com.br', 'com.ar', 'com.mx', 'com.tr', 'cl', 'my', 'sg', 'rs']),
  ...regional('live', ['com', 'ca', 'co.uk', 'fr', 'de', 'it', 'nl', 'be', 'se', 'no', 'dk', 'fi', 'at', 'ch', 'ie',
    'in', 'jp', 'cl', 'co.za', 'com.au', 'com.ar', 'com.mx', 'com.pt', 'com.sg', 'com.my', 'ru', 'hk']),
  'msn.com', 'windowslive.com', 'passport.com',
  // Yahoo / AOL
  ...regional('yahoo', ['com', 'co.uk', 'ca', 'co.nz', 'com.au', 'co.in', 'in', 'fr', 'de', 'it', 'es', 'ie', 'gr', 'se',
    'dk', 'no', 'fi', 'nl', 'be', 'at', 'ch', 'pl', 'ro', 'co.jp', 'co.id', 'co.th', 'co.za', 'co.kr', 'com.br',
    'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ph', 'com.sg', 'com.my', 'com.hk', 'com.tw', 'com.vn', 'com.tr',
    'cl', 'cn']),
  'ymail.com', 'rocketmail.com', 'myyahoo.com',
  ...regional('aol', ['com', 'co.uk', 'de', 'fr', 'it', 'es', 'nl', 'be', 'jp', 'com.au', 'com.br', 'com.mx']),
  'aim.com', 'love.com', 'games.com', 'wow.com', 'ygm.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Privacy-focused
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com', 'tutanota.de', 'tuta.io',
  'tutamail.com', 'tuta.com', 'keemail.me', 'fastmail.com', 'fastmail.fm', 'hey.com', 'posteo.de', 'posteo.net',
  'mailbox.org', 'disroot.org', 'riseup.net',
  // GMX / WEB.DE / 1&1 / mail.com family
  ...regional('gmx', ['com', 'net', 'de', 'at', 'ch', 'fr', 'es', 'it', 'us', 'co.uk', 'ca']),
  'web.de', 'email.de', 'mail.com', 'email.com', 'usa.com', 'post.com', 'consultant.com', 'myself.com',
  // Other large webmail
  'zoho.com', 'zohomail.com', 'zohomail.eu', 'zohomail.in',
  ...regional('yandex', ['com', 'ru', 'ua', 'by', 'kz', 'com.tr']), 'ya.ru',
  'mail.ru', 'inbox.ru', 'bk.ru', 'list.ru', 'internet.ru', 'rambler.ru', 'ukr.net', 'i.ua', 'meta.ua',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com',
  'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'rediffmail.com',
  'seznam.cz', 'email.cz', 'centrum.cz', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'op.pl', 'abv.bg',
  'freemail.hu', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tin.it', 'laposte.net', 'orange.fr',
  'free.fr', 'sfr.fr', 'wanadoo.fr', 'neuf.fr', 'bluewin.ch', 'terra.com.br', 'bol.com.br', 'uol.com.br',
  'freenet.de', 'arcor.de', 't-online.de', 'mail.de',
  // ISPs
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net',
  'earthlink.net', 'juno.com', 'netzero.net', 'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net',
  'ntlworld.com', 'blueyonder.co.uk', 'shaw.ca', 'rogers.com', 'sympatico.ca', 'telus.net', 'videotron.ca',
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au', 'xtra.co.nz', 'telenet.be', 'skynet.be',
  'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'home.nl', 'eircom.net', 'telia.com', 'online.no',
]);

/**
 * Domains used for typo suggestions ("did you mean"). Fuzzy matching only targets names of 9+ characters
 * (see suggest.js), so short ones like aol.com or me.com are only corrected for an obviously wrong TLD.
 */
export const SUGGEST_TARGETS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'protonmail.com', 'proton.me', 'live.com', 'msn.com', 'comcast.net', 'ymail.com', 'me.com', 'mac.com',
  'yahoo.co.uk', 'hotmail.co.uk', 'btinternet.com', 'verizon.net', 'sbcglobal.net', 'att.net',
  'rocketmail.com', 'fastmail.com', 'zoho.com', 'gmx.com', 'yandex.com', 'mail.ru',
];
