// RETOMAR: the client's time zone by the US area code of the phone, and whether it is a permitted hour to send.
// Florida 501.616(6)(a): no sales message before 8:00 or after 20:00 in the client's time zone. An area code split
// between two zones uses both (the hour must be permitted in each). Outside the US/Canada the zone is not known.
(function attachHorario(root) {
  'use strict';
  const ZONES = {
    'America/Los_Angeles': '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 837 840 858 909 916 925 949 951 206 253 360 425 509 564 458 503 541 971 702 725 775 236 250 604 672 778',
    'America/Phoenix': '480 520 602 623 928',
    'America/Denver': '303 719 720 970 983 385 435 801 505 575 406 307 915 403 587 780 825 368',
    'America/Boise': '208 986',
    'America/Chicago': '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 405 539 572 580 918 316 620 785 913 308 402 531 605 701 218 320 507 612 651 763 952 319 515 563 641 712 314 417 557 573 636 660 816 975 327 479 501 870 225 318 337 504 985 228 601 662 769 205 251 256 334 659 938 615 629 731 901 931 262 274 353 414 534 608 715 920 217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872 219 270 364 204 431 306 474 639',
    'America/Anchorage': '907',
    'Pacific/Honolulu': '808'
  };
  // Area codes covering two zones: the Florida panhandle, Indiana, Kentucky, Tennessee, Michigan, Nebraska, Kansas,
  // the Dakotas, Oregon and Idaho. The hour must be permitted in both.
  const SPLIT = {
    850: ['America/New_York', 'America/Chicago'], 812: ['America/New_York', 'America/Chicago'], 930: ['America/New_York', 'America/Chicago'],
    574: ['America/New_York', 'America/Chicago'], 606: ['America/New_York', 'America/Chicago'], 423: ['America/New_York', 'America/Chicago'],
    906: ['America/New_York', 'America/Chicago'], 308: ['America/Chicago', 'America/Denver'], 620: ['America/Chicago', 'America/Denver'],
    785: ['America/Chicago', 'America/Denver'], 605: ['America/Chicago', 'America/Denver'], 701: ['America/Chicago', 'America/Denver'],
    541: ['America/Los_Angeles', 'America/Boise'], 208: ['America/Boise', 'America/Los_Angeles'], 915: ['America/Denver', 'America/Chicago']
  };
  const BY_CODE = {};
  Object.entries(ZONES).forEach(([zone, codes]) => codes.split(' ').forEach((code) => { BY_CODE[code] = zone; }));
  const START = 8, END = 20;

  function zonesFor(phone) {
    const digits = String(phone || '').replace(/[^\d+]/g, '');
    if (/^\+55/.test(digits)) return ['America/Sao_Paulo'];
    const match = digits.match(/^\+?1(\d{3})\d{7}$/);
    if (!match) return [];
    const code = match[1];
    if (SPLIT[code]) return SPLIT[code];
    return [BY_CODE[code] || 'America/New_York'];
  }
  function hourIn(zone, at) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === 'hour').value), minute = Number(parts.find((part) => part.type === 'minute').value);
    return { hour, minute, text: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') };
  }
  // { allowed, known, local: '21:12', zone } for the phone now.
  function check(phone, at = new Date()) {
    const zones = zonesFor(phone);
    if (!zones.length) return { allowed: true, known: false, local: null, zone: null };
    const times = zones.map((zone) => ({ zone, ...hourIn(zone, at) }));
    const allowed = times.every((time) => time.hour >= START && time.hour < END);
    return { allowed, known: true, local: times[0].text, zone: times[0].zone, split: zones.length > 1 };
  }
  const api = { START, END, zonesFor, check };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MCSHorario = api;
})(typeof window !== 'undefined' ? window : null);
