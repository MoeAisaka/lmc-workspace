import * as React from 'react';
import { ItemList } from '@/components/ItemList';
import { AboutPane } from '@/components/lmc/settings/AboutPane';

export default function AboutSettingsScreen() {
    return <ItemList style={{ paddingTop: 0 }}><AboutPane /></ItemList>;
}
