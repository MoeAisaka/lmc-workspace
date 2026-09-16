import * as React from 'react';
import { ItemList } from '@/components/ItemList';
import { DevicesUpgradePane } from '@/components/lmc/settings/DevicesUpgradePane';

export default function DevicesSettingsScreen() {
    return <ItemList style={{ paddingTop: 0 }}><DevicesUpgradePane /></ItemList>;
}
