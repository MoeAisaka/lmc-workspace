import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SortableSessionRows } from './SortableSessionRows';
import { SortableHubGroups } from './lmc/SortableHubGroups';

const state = vi.hoisted(() => ({ orders: {} as Record<string, string[]> }));
vi.mock('@/sync/storage', () => ({ useSetting: () => state.orders }));

it('native rows and hubs honor the same saved account order as Web', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'new' }];
    const render = (item: { id: string }) => React.createElement('span', null, item.id);
    for (const order of [['b', 'a'], ['a', 'b']]) {
        state.orders = { group: order, hubs: order };
        const expected = [...order, 'new'].map(id => `<span>${id}</span>`).join('');
        expect(renderToStaticMarkup(React.createElement(SortableSessionRows, {
            groupId: 'group', sessions: rows, renderRow: render,
        }))).toBe(expected);
        expect(renderToStaticMarkup(React.createElement(SortableHubGroups<{ id: string }>, {
            storageKey: 'hubs', items: rows, getId: item => item.id, renderItem: render,
        }))).toBe(expected);
    }
});
