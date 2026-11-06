// Plain module (no 'use client') so the values are real numbers in Server Components too.

/** Safe margin (px) tooltips and previews keep from the viewport edge (UX12-POPPERS). */
export const POPPER_COLLISION_PADDING = 16;

/** Hover delay (ms) before a tooltip opens; keyboard focus opens it immediately. */
export const TOOLTIP_DELAY_MS = 300;
/**
 * Longer hover delay (ms) for descriptions of choices (RadioGroup `optionDescriptions="tooltip"`):
 * moving the pointer across a list of options must not flash every description.
 */
export const TOOLTIP_DESCRIPTION_DELAY_MS = 700;

/** A touch press this long opens a PreviewTooltip (QSRC-01 user decision 2026-11-04). */
export const PREVIEW_LONG_PRESS_MS = 500;
/** A PreviewTooltip closes this long after the pointer left both the trigger and the preview. */
export const PREVIEW_CLOSE_MS = 120;
