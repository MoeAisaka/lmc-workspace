import React from 'react';
import {View,Text} from 'react-native';
import {t} from '@/text';
import {StatusDot} from './StatusDot';
export interface SessionStatusIndicatorProps {state:string; showLabel?:boolean; unread?:boolean}
export function SessionStatusIndicator({state,showLabel=true}:SessionStatusIndicatorProps){
    const active=state==='thinking';const attention=state==='permission_required'||state==='input_required';
    const label=active?t('localFeatures.workingState'):attention?t('localFeatures.attentionState'):state==='waiting'?t('localFeatures.onlineState'):t('localFeatures.offlineState');
    const color=active?'#0060F0':attention?'#C5790A':state==='waiting'?'#24945B':'#888';
    return <View accessibilityLabel={label} style={{flexDirection:'row',alignItems:'center',gap:5}}><StatusDot color={color} isPulsing={active||attention} size={7}/>{showLabel&&<Text style={{fontSize:11,color}}>{label}</Text>}</View>;
}
