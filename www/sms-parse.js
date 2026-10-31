// Parses Iranian bank SMS text into {type, amt (toman), key}. Pure functions, no DOM.
(function (root) {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
      .replace(/[٬،]/g, ',')
      .replace(/ي/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[‌‏‎]/g, ' ');
  }

  const SECRET = /(رمز|کد\s*(فعال|تایید|تأیید|امنیتی|ورود|یکبار)|otp|cvv2?|pin\b)/i;
  const FIN = /(برداشت|واریز|خرید|پرداخت|انتقال|کارت\s*به\s*کارت|پایا|ساتنا|قبض|شارژ|کسر|مانده|موجودی)/;
  const INCOME_W = /(واریز|دریافت|افزایش|بازگشت|اعتبار|حقوق|سود)/;
  const EXPENSE_W = /(برداشت|خرید|پرداخت|کسر|انتقال|کارت\s*به\s*کارت|قبض|شارژ|پایا|ساتنا|چک)/;
  const LABEL_BEFORE = /(مبلغ|برداشت|واریز|خرید|پرداخت|انتقال|کسر|مبلغ\s*:)\s*[:：]?\s*[+\-]?\s*$/;

  function firstIndex(re, t) {
    const m = re.exec(t);
    return m ? m.index : -1;
  }

  function detectType(t, amtSign) {
    const iw = firstIndex(INCOME_W, t);
    const ew = firstIndex(EXPENSE_W, t);
    if (iw >= 0 && ew < 0) return 'income';
    if (ew >= 0 && iw < 0) return 'expense';
    if (iw >= 0 && ew >= 0) {
      if (amtSign === '+') return 'income';
      if (amtSign === '-') return 'expense';
      return iw < ew ? 'income' : 'expense';
    }
    if (amtSign === '+') return 'income';
    if (amtSign === '-') return 'expense';
    return 'expense';
  }

  function findAmount(t) {
    // Remove balance fragments so the balance is never mistaken for the amount.
    const cleaned = t.replace(/(مانده|موجودی)[^\d+\-]{0,25}[+\-]?\s*\d[\d,]*(\s*(ریال|تومان))?/g, ' ');
    const re = /(?<![\d\/:*.])([+\-]?)\s?(\d{1,3}(?:,\d{3})+|\d{4,9})(?![\d\/:])(\s*(ریال|تومان|rial|irr))?/gi;
    const cands = [];
    let m;
    while ((m = re.exec(cleaned))) {
      const digits = m[2].replace(/,/g, '');
      if (digits.length >= 10) continue; // account or card numbers
      const before = cleaned.slice(Math.max(0, m.index - 22), m.index);
      cands.push({
        sign: m[1] || '',
        value: parseInt(digits, 10),
        unit: m[4] ? m[4].toLowerCase() : '',
        labeled: LABEL_BEFORE.test(before),
        hasUnit: !!m[4]
      });
    }
    if (!cands.length) return null;
    return cands.find((c) => c.labeled) || cands.find((c) => c.hasUnit) || cands[0];
  }

  function merchantKey(t) {
    const re = /(?:خرید\s*از|پرداخت\s*به|پذیرنده|مرکز\s*خرید|فروشگاه)\s*[:：]?\s*([^\n,.\d]{2,40})/;
    const m = re.exec(t);
    if (!m) return '';
    let k = m[1].split(/\s(?:مبلغ|مانده|موجودی|ریال|تومان|تاریخ|ساعت|کارت|شماره)/)[0];
    k = k.replace(/\s+/g, ' ').trim();
    return k.length >= 2 ? k.slice(0, 30) : '';
  }

  function parse(body) {
    const t = norm(body);
    if (!t.trim() || SECRET.test(t)) return null;
    if (!FIN.test(t)) return null;
    if (!/(ریال|تومان|مانده|موجودی)/i.test(t)) return null;
    const a = findAmount(t);
    if (!a || !(a.value > 0)) return null;
    let toman = a.unit === 'تومان' ? a.value : a.value / 10;
    if (!a.unit && /تومان/.test(t) && !/ریال/.test(t)) toman = a.value;
    toman = Math.round(toman);
    if (toman <= 0) return null;
    return { type: detectType(t, a.sign), amt: toman, key: merchantKey(t) };
  }

  const KEYWORDS = [
    [/(کافه|قهوه|کافی\s*شاپ|کافی‌شاپ)/, 'coffee'],
    [/(اسنپ|تپسی|تاکسی|بنزین|پمپ|مترو|اتوبوس|پارکینگ|عوارض)/, 'transport'],
    [/(قبض|شارژ|اینترنت|همراه\s*اول|ایرانسل|رایتل|گاز|برق|آب\b|مخابرات)/, 'bills'],
    [/(رستوران|ساندویچ|پیتزا|کباب|نانوایی|نان\b|سوپر|هایپر|میوه|رفاه|اتکا|شهروند|دیجی\s*کالا\s*فرش|اسنپ\s*فود|اسنپ‌فود)/, 'food'],
    [/(داروخانه|دارو|درمانگاه|بیمارستان|دندان|آزمایشگاه|کلینیک|مطب)/, 'health'],
    [/(سینما|بلیط|بلیت|کنسرت|تفریح|پارک|بازی)/, 'fun'],
    [/(کارت\s*به\s*کارت|پایا|ساتنا|انتقال)/, 'transfer'],
    [/(دیجی\s*کالا|دیجیکالا|فروشگاه|پوشاک|مغازه|بازار|خرید)/, 'shop']
  ];

  function guessCategory(body, key, rules, type) {
    if (type === 'income') return 'income';
    const t = norm(body);
    if (key && rules && rules[key]) return rules[key];
    for (const [re, cat] of KEYWORDS) if (re.test(t)) return cat;
    return 'other';
  }

  const api = { parse, guessCategory, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SmsParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
