import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { productLabel } from '../api/product-adapter'
import type { ProductKind } from '../types'

interface FormatDriftBannerProps {
  // Products whose official login format no longer matches, with the reason.
  drift: Partial<Record<ProductKind, string>>
  onOpenReleases: () => void
  onDismiss: () => void
}

// Shown when an official client changed its on-disk login format. The engine
// can still read what it knows, but a switch or sync may fail; the fix is a
// newer version of this app, so the banner points at the releases page.
export default function FormatDriftBanner({ drift, onOpenReleases, onDismiss }: FormatDriftBannerProps) {
  const products = (Object.keys(drift) as ProductKind[]).filter((product) => drift[product])
  if (!products.length) return null
  const names = products.map((product) => productLabel(product)).join('、')
  const detail = products.map((product) => drift[product]).join('；')

  return (
    <div
      className="rounded-xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 flex items-center gap-3"
      id="format-drift-banner"
      role="status"
    >
      <AlertTriangle className="w-4 h-4 text-warn shrink-0" />
      <p className="min-w-0 flex-1 text-left text-[13px] leading-5" title={detail}>
        <span className="font-bold text-label">官方 {names} 的登录格式变了</span>
        <span className="text-label-2"> · 切号和同步可能失效，请更新到新版本。{detail}</span>
      </p>
      <button
        type="button"
        onClick={onOpenReleases}
        className="shrink-0 rounded-lg border border-accent/20 bg-accent/12 px-2.5 py-1.5 text-[11px] font-bold text-accent hover:bg-accent/20 cursor-pointer flex items-center gap-1"
        id="format-drift-releases"
      >
        查看新版本
        <ExternalLink className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="p-1.5 shrink-0 rounded-lg text-label-2 hover:bg-fill-2 hover:text-label cursor-pointer"
        title="本次不再提示"
        id="format-drift-dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
