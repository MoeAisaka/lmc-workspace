import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { lmcLogin } from '@/auth/lmcAuth';
import { t } from '@/text';

export function LmcLogin() {
    const { theme }=useUnistyles(), auth=useAuth();
    const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const submit=async()=>{if(busy)return;setBusy(true);setError('');try{const credentials=await lmcLogin(username.trim(),password);await auth.login(credentials.token,credentials.secret);}catch(e){setError(e instanceof Error?e.message:'登录失败');}finally{setBusy(false);}};
    const input={borderWidth:1,borderColor:theme.colors.divider,borderRadius:12,padding:14,fontSize:16,color:theme.colors.text,marginTop:12} as const;
    return <View style={{flex:1,justifyContent:'center',alignItems:'center',padding:24,backgroundColor:theme.colors.surface}}>
        <View style={{width:'100%',maxWidth:360}}>
            <Text accessibilityRole="header" style={{fontSize:30,fontWeight:'700',color:theme.colors.text}}>Link my Cli</Text>
            <Text style={{fontSize:15,marginTop:12,marginBottom:20,color:theme.colors.textSecondary}}>{t('lmc.empty.loginSubtitle')}</Text>
            <TextInput accessibilityLabel={t('lmc.login.username')} placeholder={t('lmc.login.username')} autoComplete="username" autoCapitalize="none" value={username} onChangeText={setUsername} style={input}/>
            <TextInput accessibilityLabel={t('lmc.login.password')} placeholder={t('lmc.login.password')} autoComplete="current-password" secureTextEntry value={password} onChangeText={setPassword} onSubmitEditing={submit} style={input}/>
            {!!error&&<Text accessibilityRole="alert" style={{color:'#d32f2f',marginTop:12}}>{error}</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.login.signIn')} disabled={busy||!username||!password} onPress={submit} style={{marginTop:22,borderRadius:24,backgroundColor:theme.colors.text,padding:15,alignItems:'center',opacity:busy||!username||!password?0.5:1}}>
                {busy?<ActivityIndicator color={theme.colors.surface}/>:<Text style={{color:theme.colors.surface,fontWeight:'600',fontSize:16}}>{t('lmc.login.signIn')}</Text>}
            </Pressable>
            <Text style={{marginTop:20,color:theme.colors.textSecondary,lineHeight:21}}>{t('lmc.empty.loginFooter')}</Text>
        </View>
    </View>;
}
