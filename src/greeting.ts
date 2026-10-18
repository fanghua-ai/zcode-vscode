// Match the desktop new-chat greeting periods using the user's local clock.
const periods = [5, 9, 12, 14, 18, 23] as const;
const keys = ["早上好呀，新的一天开始啦", "上午好呀，有什么想让我帮忙的吗", "中午好呀，要不要先休息一下", "下午好呀，接下来交给我吧", "晚上好呀，今天辛苦啦", "夜深啦，别忘了照顾好自己哦"] as const;

export function greetingKey(now = new Date()): string {
  const hour = now.getHours();
  const index = periods.findIndex((start, i) => i < periods.length - 1 && hour >= start && hour < periods[i + 1]);
  return keys[index < 0 ? 5 : index];
}

export function nextGreetingDelay(now = new Date()): number {
  for (const hour of periods) {
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() > now.getTime()) return next.getTime() - now.getTime();
  }
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(periods[0], 0, 0, 0);
  return next.getTime() - now.getTime();
}
