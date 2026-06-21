export interface RuntimeTimeContext {
  isoUtc: string;
  localDate: string;
  localDateTime: string;
  weekday: string;
  timeZone: string;
}

export interface CalendarObservance {
  nameZh: string;
  nameEn: string;
  reasonZh: string;
  reasonEn: string;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value || "";
}

export function getRuntimeTimeContext(
  locale = "zh-CN",
  now = new Date()
): RuntimeTimeContext {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const year = part(dateParts, "year");
  const month = part(dateParts, "month");
  const day = part(dateParts, "day");
  const hour = part(dateParts, "hour");
  const minute = part(dateParts, "minute");
  const second = part(dateParts, "second");
  return {
    isoUtc: now.toISOString(),
    localDate: `${year}-${month}-${day}`,
    localDateTime: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    weekday: new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: "long"
    }).format(now),
    timeZone
  };
}

export function localDateSearchLabel(context: RuntimeTimeContext): string {
  const [year, month, day] = context.localDate.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function calendarObservances(context: RuntimeTimeContext): CalendarObservance[] {
  const [yearText, monthText, dayText] = context.localDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const observances: CalendarObservance[] = [];
  if (month === 6 && weekday === 0 && day >= 15 && day <= 21) {
    observances.push({
      nameZh: "父亲节",
      nameEn: "Father's Day",
      reasonZh: "六月的第三个星期日",
      reasonEn: "the third Sunday in June"
    });
  }
  if (month === 6 && day === 21) {
    observances.push({
      nameZh: "国际瑜伽日",
      nameEn: "International Day of Yoga",
      reasonZh: "联合国确定的每年 6 月 21 日纪念日",
      reasonEn: "a United Nations observance held every June 21"
    });
  }
  return observances;
}
