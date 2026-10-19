'use client';

import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from '../internal/cx';

export type TabsProps = ComponentProps<typeof RadixTabs.Root>;
export type TabsListProps = ComponentProps<typeof RadixTabs.List>;
export type TabsTriggerProps = ComponentProps<typeof RadixTabs.Trigger>;
export type TabsContentProps = ComponentProps<typeof RadixTabs.Content>;

/**
 * Tabs on Radix (WAI-ARIA tabs pattern: Arrow/Home/End move between tabs, each panel is labelled
 * by its tab). Control `value` to keep the selected tab in the URL.
 */
export function Tabs({ className, ...rest }: TabsProps) {
  return <RadixTabs.Root className={cx('qz-tabs', className)} {...rest} />;
}

/** Give the list an accessible name (`aria-label`) describing what the tabs switch. */
export function TabsList({ className, ...rest }: TabsListProps) {
  return <RadixTabs.List className={cx('list', className)} {...rest} />;
}

export function TabsTrigger({ className, ...rest }: TabsTriggerProps) {
  return <RadixTabs.Trigger className={cx('trigger', 'qz-focus-ring', className)} {...rest} />;
}

export function TabsContent({ className, ...rest }: TabsContentProps) {
  return <RadixTabs.Content className={cx('content', 'qz-focus-ring', className)} {...rest} />;
}
