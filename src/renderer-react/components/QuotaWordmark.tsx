import wordmark from '../assets/quota-wordmark.png';
import { APP_DISPLAY_NAME } from '../brand';

export default function QuotaWordmark() {
  return (
    <img
      src={wordmark}
      alt={APP_DISPLAY_NAME}
      draggable={false}
      className="h-10 w-auto max-w-[168px] object-contain object-left pointer-events-none select-none"
      id="sidebar-wordmark"
    />
  );
}
