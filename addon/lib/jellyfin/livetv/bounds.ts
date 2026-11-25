// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE

/** The longest of each kind of text kept from an addon. */
export const MAX_ID = 256;
export const MAX_NAME = 300;
export const MAX_GROUP_NAME = 200;
export const MAX_TEXT = 4000;
const MAX_URL = 2048;
const MAX_SHORT = 64;

export const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const within = (value: unknown, max: number): string | undefined => {
  const given = text(value);
  return given && given.length <= max ? given : undefined;
};

/** For what is of no use cut short. */
export const idOf = (value: unknown): string | undefined => within(value, MAX_ID);
export const urlOf = (value: unknown): string | undefined => within(value, MAX_URL);
export const shortOf = (value: unknown): string | undefined => within(value, MAX_SHORT);
export const groupNameOf = (value: unknown): string | undefined => within(value, MAX_GROUP_NAME);

/** Cut to its first characters, as a string of its own: a slice would keep all of it. */
export function clipped(value: unknown, max: number): string | undefined {
  const given = text(value);
  return given === undefined || given.length <= max ? given : Buffer.from(given.slice(0, max)).toString();
}

/** About what a string takes in memory. */
export const bytesOf = (value: string): number => 24 + (/[Ā-￿]/.test(value) ? value.length * 2 : value.length);
