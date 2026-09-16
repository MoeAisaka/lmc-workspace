import { getServerUrl } from '@/sync/serverConfig';
import { useAuth } from '@/auth/AuthContext';
import { LmcLogin } from '@/components/LmcLogin';
import React, { useState, useEffect } from 'react';
import { View, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectAccount } from '@/hooks/useConnectAccount';
import { accountPairingUrl } from '@/utils/accountLinkUrl';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { t } from '@/text';

/**
 * Approve a new device from a browser link, the way terminal/connect.tsx does.
 *
 * Account pairing used to be reachable only through the `happy://` scheme, which
 * a native build has to register — so it could not move off the old name without
 * shipping to the stores. This path needs no scheme at all.
 */
export default function AccountConnectScreen() {
    const router = useRouter();
    const auth = useAuth();
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [hashProcessed, setHashProcessed] = useState(false);
    const { processAuthUrl, isLoading } = useConnectAccount({
        onSuccess: () => {
            router.back();
        }
    });

    // The key arrives in the fragment, which never reaches the server.
    useEffect(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined' && !hashProcessed) {
            const hash = window.location.hash;
            if (hash.startsWith('#key=')) {
                setPublicKey(hash.substring('#key='.length));
                // Keep it out of browser history.
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            setHashProcessed(true);
        }
    }, [hashProcessed]);

    const handleConnect = async () => {
        if (publicKey) {
            await processAuthUrl(accountPairingUrl(getServerUrl(), publicKey));
        }
    };

    if (!auth.isAuthenticated) return <LmcLogin />;

    const centered = { alignItems: 'center' as const, paddingVertical: 32, paddingHorizontal: 16 };

    if (Platform.OS !== 'web') {
        return (
            <ItemList><ItemGroup><View style={centered}>
                <Ionicons name="phone-portrait-outline" size={64} color="#8E8E93" style={{ marginBottom: 16 }} />
                <Text style={{ ...Typography.default('semiBold'), fontSize: 18, textAlign: 'center', marginBottom: 12 }}>
                    {t('terminal.webBrowserRequired')}
                </Text>
                <Text style={{ ...Typography.default(), fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 20 }}>
                    {t('terminal.webBrowserRequiredDescription')}
                </Text>
            </View></ItemGroup></ItemList>
        );
    }

    if (!hashProcessed) {
        return (
            <ItemList><ItemGroup><View style={centered}>
                <Text style={{ ...Typography.default(), color: '#666' }}>{t('terminal.processingConnection')}</Text>
            </View></ItemGroup></ItemList>
        );
    }

    if (!publicKey) {
        return (
            <ItemList><ItemGroup><View style={centered}>
                <Ionicons name="warning-outline" size={48} color="#FF3B30" style={{ marginBottom: 16 }} />
                <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: '#FF3B30', textAlign: 'center', marginBottom: 8 }}>
                    {t('terminal.invalidConnectionLink')}
                </Text>
                <Text style={{ ...Typography.default(), fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 20 }}>
                    {t('terminal.invalidConnectionLinkDescription')}
                </Text>
            </View></ItemGroup></ItemList>
        );
    }

    return (
        <ItemList>
            <ItemGroup>
                <View style={{ alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16 }}>
                    <Ionicons name="key-outline" size={48} color="#0060F0" style={{ marginBottom: 16 }} />
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 20, textAlign: 'center', marginBottom: 12 }}>
                        {t('navigation.linkNewDevice')}
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 20 }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>
                </View>
            </ItemGroup>

            <ItemGroup title={t('terminal.connectionDetails')}>
                <Item
                    title={t('terminal.publicKey')}
                    detail={`${publicKey.substring(0, 12)}...`}
                    icon={<Ionicons name="key-outline" size={29} color="#0060F0" />}
                    showChevron={false}
                />
                <Item
                    title={t('terminal.encryption')}
                    detail={t('terminal.endToEndEncrypted')}
                    icon={<Ionicons name="lock-closed-outline" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup>
                <View style={{ paddingHorizontal: 16, paddingVertical: 16, gap: 12 }}>
                    <RoundButton
                        title={isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                        onPress={handleConnect}
                        size="large"
                        disabled={isLoading}
                        loading={isLoading}
                    />
                    <RoundButton
                        title={t('terminal.reject')}
                        onPress={() => router.back()}
                        size="large"
                        display="inverted"
                        disabled={isLoading}
                    />
                </View>
            </ItemGroup>

            <ItemGroup title={t('terminal.security')} footer={t('terminal.securityFooter')}>
                <Item
                    title={t('terminal.clientSideProcessing')}
                    subtitle={t('terminal.linkProcessedLocally')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}
