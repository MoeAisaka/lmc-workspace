import * as React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { getTimelineStatus } from '@/utils/turnTimeline';
interface ToolStatusIndicatorProps {
    tool: ToolCall;
    active?: boolean;
}

export function ToolStatusIndicator({ tool, active = true }: ToolStatusIndicatorProps) {
    const status = getTimelineStatus(tool, active);
    return (
        <View style={styles.container}>
            {status === 'unknown' || status === 'stopped'
                ? <Ionicons name={status === 'stopped' ? 'stop-circle-outline' : 'help-circle-outline'} size={22} color="#8E8E93" />
                : <StatusIndicator state={tool.state} />}
        </View>
    );
}

function StatusIndicator({ state }: { state: ToolCall['state'] }) {
    switch (state) {
        case 'running':
            return <ActivityIndicator size="small" color="#0060F0" />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color="#FF3B30" />;
        default:
            return null;
    }
}

const styles = StyleSheet.create({
    container: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
