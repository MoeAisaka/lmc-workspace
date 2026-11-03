import * as React from 'react';
import type { SharingPolicy } from '@/sync/apiAccounts';

export interface SettingsSubpageInput {
    key: string;
    title: string;
    render: () => React.ReactNode;
}

export interface SettingsNavigationController {
    readonly isEmbeddedInSettings: true;
    pushSubpage: (entry: SettingsSubpageInput) => void;
    popSubpage: () => void;
    popToIndex: (index: number) => void;
    resetSubpages: () => void;
    closeSettings: () => void;
    openChangelog: () => void;
    openMachineDetails: (machineId: string) => void;
    openMembers: () => void;
    openResourceSharingList: (ownerId?: string, ownerLabel?: string) => void;
    openResourceSharing: (
        kind: string,
        id: string,
        options?: { onSaved?: (policy: SharingPolicy) => void },
    ) => void;
    openConnectClaude: () => void;
}

export const SettingsNavigationContext = React.createContext<SettingsNavigationController | null>(null);

export function useSettingsNavigation(): SettingsNavigationController | null {
    return React.useContext(SettingsNavigationContext);
}
