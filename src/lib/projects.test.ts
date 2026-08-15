import { describe, expect, it } from 'vitest';
import { isSelectable, serializeProject, toProject, type ProjectRow } from './projects';

describe('toProject', () => {
  it('maps a valid row to the domain shape', () => {
    const row: ProjectRow = {
      id: 'p1',
      name: 'Thesis',
      category: 'study',
      archived_at: null,
      created_at: 1000,
    };
    expect(toProject(row)).toEqual({
      id: 'p1',
      name: 'Thesis',
      category: 'study',
      archivedAt: null,
      createdAt: 1000,
    });
  });

  it('throws on an unknown category', () => {
    const row: ProjectRow = {
      id: 'p1',
      name: 'Thesis',
      category: 'bogus',
      archived_at: null,
      created_at: 1000,
    };
    expect(() => toProject(row)).toThrow(/unknown category/);
  });
});

describe('serializeProject', () => {
  it('round-trips through toProject', () => {
    const row: ProjectRow = {
      id: 'p1',
      name: 'Freelance client X',
      category: 'work',
      archived_at: 2000,
      created_at: 1000,
    };
    expect(serializeProject(toProject(row))).toEqual(row);
  });
});

describe('isSelectable', () => {
  it('is true for an active project and false for an archived one', () => {
    const active = toProject({ id: 'p1', name: 'A', category: 'personal', archived_at: null, created_at: 1000 });
    const archived = toProject({ id: 'p2', name: 'B', category: 'personal', archived_at: 2000, created_at: 1000 });
    expect(isSelectable(active)).toBe(true);
    expect(isSelectable(archived)).toBe(false);
  });
});
