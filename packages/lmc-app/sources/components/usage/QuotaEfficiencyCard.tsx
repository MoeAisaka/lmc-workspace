import { DashboardCard } from '@/components/usage/DashboardCard';
import * as React from 'react';
import { View, ScrollView } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { lmcColors } from '@/components/lmc/lmcColors';
import { useQuotaHistory } from '@/sync/useQuotaHistory';
import { quotaEfficiency } from '@/sync/quotaEfficiency';
import { compactTokens as fmt } from '@/sync/usageAnalytics';
import { getDateLocale, t } from '@/text';
import type { UsageRecord } from 'lmc-wire';
const styles=StyleSheet.create(theme=>({
    card:{padding:16,gap:14,borderRadius:16,backgroundColor:theme.colors.surface,borderWidth:1,borderColor:lmcColors(theme).border},
    title:{fontSize:16,lineHeight:24,fontWeight:'600',color:theme.colors.text},
    text:{fontSize:13,lineHeight:21,color:theme.colors.text},muted:{fontSize:12,lineHeight:19,color:theme.colors.textSecondary},
    row:{flexDirection:'row',gap:8,flexWrap:'wrap',alignItems:'center'},
    chip:{paddingHorizontal:12,paddingVertical:8,borderRadius:10,backgroundColor:lmcColors(theme).subtle},
    active:{backgroundColor:lmcColors(theme).brand},cell:{width:140,padding:10,color:theme.colors.text,fontSize:13,lineHeight:20},
}));
export function QuotaEfficiencyCard({records,range,machineNames}:{records:UsageRecord[];range:{start:number;end:number};machineNames:Record<string,string>}){
    const history=useQuotaHistory(range.start,range.end);
    const [source,setSource]=React.useState('');const [engine,setEngine]=React.useState('agy');
    const [pool,setPool]=React.useState('gemini');const [window,setWindow]=React.useState('five_hour');const [allMachines,setAllMachines]=React.useState(false);
    const sources=[...new Set(history.observations.map(s=>s.machineId))];
    const machineId=sources.includes(source)?source:sources[0]??'';
    const selectedPool=engine==='agy'?pool:'account';
    const analysis=React.useMemo(()=>quotaEfficiency(history.observations,records,{machineId,engine,pool:selectedPool,window,allMachines}),[history.observations,records,machineId,engine,selectedPool,window,allMachines]);
    const choice=(id:string,label:string,active:boolean,fn:()=>void)=><Pressable key={id} accessibilityRole="button" accessibilityState={{selected:active}} onPress={fn} style={[styles.chip,active&&styles.active]}><Text style={[styles.text,active&&{color:'#fff'}]}>{label}</Text></Pressable>;
    return <DashboardCard testID="quota-efficiency" style={styles.card}>
        <Text style={styles.title}>{t('lmc.usage.efficiencyTitle')}</Text>
        <View style={styles.row}>{[['agy','Antigravity'],['codex','Codex'],['claude','Claude Code']].map(([id,label])=>choice(id,label,engine===id,()=>setEngine(id)))}</View>
        {sources.length>0&&<View style={styles.row}><Text style={styles.muted}>{t('lmc.usage.quotaSource')}</Text>{sources.map(id=>choice(id,machineNames[id]??t('lmc.usage.deviceFallback',{id:id.slice(-6)}),machineId===id,()=>{setSource(id);setAllMachines(false);} ))}</View>}
        <View style={styles.row}>{engine==='agy'&&[['gemini',t('lmc.usage.poolGemini')],['claude_gpt',t('lmc.usage.poolClaudeGpt')]].map(([id,label])=>choice(id,label,pool===id,()=>setPool(id)))}
            {choice('5h',t('lmc.usage.window5h'),window==='five_hour',()=>setWindow('five_hour'))}{choice('week',t('lmc.usage.windowWeek'),window==='seven_day',()=>setWindow('seven_day'))}</View>
        <View style={styles.row}>{choice('scope',allMachines?t('lmc.usage.scopeMerged'):t('lmc.usage.scopeSourceOnly'),allMachines,()=>setAllMachines(v=>!v))}<Text style={styles.muted}>{t('lmc.usage.scopeHint')}</Text></View>
        <Text style={styles.text}>{t('lmc.usage.burnSummary',{points:analysis.intervals>0?analysis.points.toFixed(2):'—',ambiguous:analysis.intervals>0?analysis.ambiguousPoints.toFixed(2):'—'})}</Text>
        {history.error&&<Text accessibilityRole="alert" style={styles.muted}>{history.error}</Text>}
        {!history.error&&analysis.sampleCount<2&&<Text style={styles.muted}>{history.loading?t('lmc.usage.loadingQuotaSamples'):t('lmc.usage.waitingQuotaSamples')}</Text>}
        <ScrollView horizontal><View>
            <View style={styles.row}>{[t('lmc.usage.colModel'),t('lmc.usage.colTotalTokens'),t('lmc.usage.colMatchedSamples'),t('lmc.usage.colBurnPoints'),t('lmc.usage.colTokensPerPoint'),t('lmc.usage.colPointsPerHundredMillion')].map((v,i)=><Text key={v} style={[styles.cell,{fontWeight:'600'},i===0&&{width:260}]}>{v}</Text>)}</View>
            {analysis.models.map(m=><View key={m.model} style={styles.row}>
                <Text style={[styles.cell,{width:260}]}>{m.model}</Text><Text style={styles.cell}>{fmt(m.tokens)}</Text>
                <Text style={styles.cell}>{fmt(m.matchedTokens)} / {m.samples}</Text><Text style={styles.cell}>{m.samples?m.points.toFixed(2):'—'}</Text>
                <Text style={styles.cell}>{m.points>0?fmt(m.matchedTokens/m.points):'—'}</Text><Text style={styles.cell}>{m.matchedTokens>0?(m.points*1e8/m.matchedTokens).toFixed(2):'—'}</Text>
            </View>)}
        </View></ScrollView>
        {!analysis.models.length&&<Text style={styles.muted}>{t('lmc.usage.noPoolRecords')}</Text>}
        <Text style={styles.muted}>{t('lmc.usage.sampleStats',{samples:analysis.sampleCount,intervals:analysis.intervals,excluded:analysis.excluded,last:analysis.last?new Date(analysis.last).toLocaleString(getDateLocale()):''})}</Text>
        <Text style={styles.muted}>{t('lmc.usage.efficiencyFootnote1')}</Text>
        <Text style={styles.muted}>{t('lmc.usage.efficiencyFootnote2')}</Text>
    </DashboardCard>;
}
