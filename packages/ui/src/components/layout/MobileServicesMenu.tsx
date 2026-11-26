import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { McpIcon } from '@/components/icons/McpIcon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { ThreadTokenUsage } from '@/components/thread/ThreadTokenUsage';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { cn } from '@/lib/utils';

export function MobileServicesMenu({ open, onOpenChange, tab, setTab }: { open: boolean; onOpenChange(value: boolean): void; tab: 'usage' | 'mcp'; setTab(value: 'usage' | 'mcp'): void }) {
  const { t } = useI18n();
  const tabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return [
      { id: 'usage', label: t('layout.services.usage'), icon: <Icon name="timer" className="h-3.5 w-3.5" /> },
      { id: 'mcp', label: 'MCP', icon: <McpIcon className="h-3.5 w-3.5" /> },
    ];
  }, [t]);
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger type="button" aria-label={t('header.services.viewAria')} className="mobile-page-action"><Icon name="stack" className="size-5" /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-50">
        <Popover.Popup
          aria-label={t('header.services.title')}
          className={cn(
            dropdownMenuPopupClass,
            'flex max-h-[min(28rem,65dvh,var(--available-height))] w-[min(22rem,var(--available-width))] min-w-0 flex-col overflow-hidden rounded-xl bg-[var(--surface-elevated)] p-0 text-[var(--surface-elevated-foreground)] outline-none'
          )}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2.5 py-2">
            <SortableTabsStrip
              items={tabItems}
              activeId={tab}
              onSelect={tab => setTab(tab as 'usage' | 'mcp')}
              layoutMode="fit"
              variant="active-pill"
              activePillInsetClassName="gap-0.5 px-px py-0"
              activePillButtonClassName="h-8"
              activePillLowercase={false}
              className="h-9 min-w-0 flex-1"
            />
            <Popover.Close
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('header.services.closeAria')}
            >
              <Icon name="close" className="size-5" />
            </Popover.Close>
          </div>
          <div key={tab} className="min-h-0 overflow-y-auto overscroll-contain">
            {tab === 'mcp'
              ? <McpDropdownContent active={open} mobileListDensity onNavigate={() => onOpenChange(false)} />
              : <ThreadTokenUsage active={open} />}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
