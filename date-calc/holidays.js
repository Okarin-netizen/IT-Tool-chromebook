// Japanese national holidays (国民の祝日), worked out by the rules in the 祝日法 as they are from
// 2022 on. Earlier years can differ (the Olympic years 2020 and 2021 moved some days).

// Fixed-date holidays: "month-day" → name.
const FIXED = {
  "1-1": "元日",
  "2-11": "建国記念の日",
  "2-23": "天皇誕生日",
  "4-29": "昭和の日",
  "5-3": "憲法記念日",
  "5-4": "みどりの日",
  "5-5": "こどもの日",
  "8-11": "山の日",
  "11-3": "文化の日",
  "11-23": "勤労感謝の日",
};

// Happy Monday holidays: [month, which Monday, name].
const MONDAYS = [
  [1, 2, "成人の日"],
  [7, 3, "海の日"],
  [9, 3, "敬老の日"],
  [10, 2, "スポーツの日"],
];

const SUNDAY = 0;
const MONDAY = 1;
const cache = new Map();

// The day of the month of the nth Monday.
function nthMonday(year, month, nth) {
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const firstMonday = 1 + ((MONDAY - firstWeekday + 7) % 7);
  return firstMonday + (nth - 1) * 7;
}

// The equinox days by the usual formula (good for 1980–2099).
function equinoxDay(year, base) {
  const years = year - 1980;
  return Math.floor(base + 0.242194 * years - Math.floor(years / 4));
}

const key = (month, day) => `${month}-${day}`;

function namedHolidays(year) {
  const days = new Map(Object.entries(FIXED));
  for (const [month, nth, name] of MONDAYS) days.set(key(month, nthMonday(year, month, nth)), name);
  days.set(key(3, equinoxDay(year, 20.8431)), "春分の日");
  days.set(key(9, equinoxDay(year, 23.2488)), "秋分の日");
  return days;
}

// A holiday on a Sunday moves to the next day that is not a holiday (振替休日), and a day between
// two holidays is a holiday too (国民の休日).
function addSubstitutes(year, days) {
  const isHoliday = (date) => days.has(key(date.getMonth() + 1, date.getDate()));
  for (let date = new Date(year, 0, 1); date.getFullYear() === year; date.setDate(date.getDate() + 1)) {
    if (!isHoliday(date) || date.getDay() !== SUNDAY) continue;
    const next = new Date(date);
    do next.setDate(next.getDate() + 1); while (isHoliday(next));
    if (next.getFullYear() === year) days.set(key(next.getMonth() + 1, next.getDate()), "振替休日");
  }
  for (let date = new Date(year, 0, 2); date.getFullYear() === year; date.setDate(date.getDate() + 1)) {
    const before = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    const after = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    const between = !isHoliday(date) && isHoliday(before) && isHoliday(after) && date.getDay() !== SUNDAY;
    if (between) days.set(key(date.getMonth() + 1, date.getDate()), "国民の休日");
  }
}

function holidaysOf(year) {
  if (!cache.has(year)) {
    const days = namedHolidays(year);
    addSubstitutes(year, days);
    cache.set(year, days);
  }
  return cache.get(year);
}

// The holiday's name, or "" when the date is not a holiday.
export function holidayName(date) {
  return holidaysOf(date.getFullYear()).get(key(date.getMonth() + 1, date.getDate())) ?? "";
}
