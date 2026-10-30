import React from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { SavedFileDialog } from '@/components/SavedFileDialog';
export default function SavedFileRoute() {
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.groupped.background }}>
        <Stack.Screen options={{ headerShown: false }} />
        <SavedFileDialog id={id} onClose={() => router.canGoBack() ? router.back() : router.replace('/')} />
    </View>;
}
