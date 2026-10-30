import { Text } from '@/components/StyledText';
import React, { useState } from 'react';
import { View, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { lmcLogin } from '@/auth/lmcAuth';
import { t } from '@/text';
import { currentInvitation, clearInvitation } from '@/auth/invitation';
import { getServerUrl } from '@/sync/serverConfig';

export function LmcLogin() {
    const { theme }=useUnistyles(), auth=useAuth();
    const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const [invitation, setInvitation] = useState(currentInvitation);
    const submit=async()=>{if(busy)return;setBusy(true);setError('');try{
        if (invitation) {
            const response = await fetch(getServerUrl() + '/v1/lmc/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitation, username: username.trim(), password }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '加入失败，请重试');
            clearInvitation(); setInvitation(null);
        }
        const credentials=await lmcLogin(username.trim(),password);await auth.login(credentials.token,credentials.secret);
    }catch(e){setError(e instanceof Error?e.message:'登录失败');}finally{setBusy(false);}};
    const input={borderWidth:1,borderColor:theme.colors.divider,borderRadius:12,padding:14,fontSize:16,color:theme.colors.text,marginTop:12} as const;
    if (invitation && auth.isAuthenticated) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 20, backgroundColor: theme.colors.surface }}>
        <Text style={{ color: theme.colors.text, maxWidth: 360, lineHeight: 24 }}>此浏览器已经登录 LMC。接受邀请会创建另一个独立账号，请先退出当前账号，或在另一浏览器或独立浏览器资料中打开邀请。</Text>
        <Pressable accessibilityRole="button" onPress={() => void auth.logout().catch(e => setError(e.message))} style={{ padding: 16 }}><Text style={{ color: theme.colors.textLink }}>退出并接受邀请</Text></Pressable>
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
    </View>;
    return <View style={{flex:1,justifyContent:'center',alignItems:'center',padding:24,backgroundColor:theme.colors.surface}}>
        <View style={{width:'100%',maxWidth:360}}>
            <Text accessibilityRole="header" style={{fontSize:30,fontWeight:'700',color:theme.colors.text}}>Link my Cli</Text>
            {invitation && <Text style={{ fontSize: 16, marginTop: 12, color: theme.colors.text }}>受邀加入：设置你自己的账号和密码（至少 12 个字符）。</Text>}
            <Text style={{fontSize:15,marginTop:12,marginBottom:20,color:theme.colors.textSecondary}}>{t('lmc.empty.loginSubtitle')}</Text>
            <TextInput accessibilityLabel={t('lmc.login.username')} placeholder={t('lmc.login.username')} autoComplete="username" autoCapitalize="none" value={username} onChangeText={setUsername} style={input}/>
            <TextInput accessibilityLabel={t('lmc.login.password')} placeholder={t('lmc.login.password')} autoComplete={invitation ? 'new-password' : 'current-password'} secureTextEntry value={password} onChangeText={setPassword} onSubmitEditing={submit} style={input}/>
            {!!error&&<Text accessibilityRole="alert" style={{color:'#d32f2f',marginTop:12}}>{error}</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.login.signIn')} disabled={busy||!username||!password} onPress={submit} style={{marginTop:22,borderRadius:24,backgroundColor:theme.colors.text,padding:15,alignItems:'center',opacity:busy||!username||!password?0.5:1}}>
                {busy?<ActivityIndicator color={theme.colors.surface}/>:<Text style={{color:theme.colors.surface,fontWeight:'600',fontSize:16}}>{invitation ? '创建账号并加入' : t('lmc.login.signIn')}</Text>}
            </Pressable>
            <Text style={{marginTop:20,color:theme.colors.textSecondary,lineHeight:21}}>{t('lmc.empty.loginFooter')}</Text>
        </View>
    </View>;
}
