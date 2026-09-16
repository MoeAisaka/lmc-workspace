import React from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';

export function ProjectAvatarActions({anchor,onClose,onPick,onRestore,hasCustomAvatar}: {
    anchor: {x:number;y:number}|null; onClose:()=>void; onPick:()=>void; onRestore:()=>void; hasCustomAvatar:boolean;
}) {
    const {theme}=useUnistyles(); const {width,height}=useWindowDimensions();
    React.useEffect(()=>{
        if (!anchor || Platform.OS !== 'web') return;
        const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();onClose();}};
        window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);
    },[anchor,onClose]);
    if(!anchor || Platform.OS !== 'web')return null;
    const menuWidth=Math.min(264,width-24);
    const actions=[{label:t('localFeatures.changeProjectAvatar'),icon:'image-outline' as const,run:onPick},
        ...(hasCustomAvatar?[{label:t('projectAvatar.restore'),icon:'refresh-outline' as const,run:onRestore}]:[])];
    return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
        <View style={{flex:1}}>
            <Pressable accessibilityLabel={t('common.cancel')} onPress={onClose} style={{position:'absolute',inset:0,backgroundColor:'#00000012'} as any}/>
            <View accessibilityRole="menu" style={{position:'absolute',left:Math.max(12,Math.min(anchor.x,width-menuWidth-12)),top:Math.max(12,Math.min(anchor.y,height-actions.length*50-12)),width:menuWidth,borderRadius:14,overflow:'hidden',backgroundColor:theme.colors.surface,boxShadow:'0 10px 36px #0003'} as any}>
                {actions.map(action=><Pressable key={action.icon} accessibilityRole="menuitem" onPress={action.run}
                    style={({pressed})=>({minHeight:50,paddingHorizontal:16,flexDirection:'row',alignItems:'center',gap:12,backgroundColor:pressed?theme.colors.divider:'transparent'})}>
                    <Ionicons name={action.icon} size={19} color={theme.colors.text}/><Text style={{fontSize:15,color:theme.colors.text}}>{action.label}</Text>
                </Pressable>)}
            </View>
        </View>
    </Modal>;
}
