import * as React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { lmcColors } from '@/components/lmc/lmcColors';
import { useQuotaHistory } from '@/sync/useQuotaHistory';
import { quotaEfficiency } from '@/sync/quotaEfficiency';
import { compactTokens as fmt } from '@/sync/usageAnalytics';
import type { UsageRecord } from 'lmc-wire';
const styles=StyleSheet.create(t=>({
    card:{padding:16,gap:14,borderRadius:16,backgroundColor:t.colors.surface,borderWidth:1,borderColor:lmcColors(t).border},
    title:{fontSize:16,lineHeight:24,fontWeight:'600',color:t.colors.text},
    text:{fontSize:13,lineHeight:21,color:t.colors.text},muted:{fontSize:12,lineHeight:19,color:t.colors.textSecondary},
    row:{flexDirection:'row',gap:8,flexWrap:'wrap',alignItems:'center'},
    chip:{paddingHorizontal:12,paddingVertical:8,borderRadius:10,backgroundColor:lmcColors(t).subtle},
    active:{backgroundColor:lmcColors(t).brand},cell:{width:140,padding:10,color:t.colors.text,fontSize:13,lineHeight:20},
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
    return <View testID="quota-efficiency" style={styles.card}>
        <Text style={styles.title}>模型额度消耗与 Token 效率</Text>
        <View style={styles.row}>{[['agy','Antigravity'],['codex','Codex'],['claude','Claude Code']].map(([id,label])=>choice(id,label,engine===id,()=>setEngine(id)))}</View>
        {sources.length>0&&<View style={styles.row}><Text style={styles.muted}>额度来源</Text>{sources.map(id=>choice(id,machineNames[id]??`设备 ${id.slice(-6)}`,machineId===id,()=>{setSource(id);setAllMachines(false);} ))}</View>}
        <View style={styles.row}>{engine==='agy'&&[['gemini','Gemini 共享池'],['claude_gpt','Claude / GPT 共享池']].map(([id,label])=>choice(id,label,pool===id,()=>setPool(id)))}
            {choice('5h','5 小时额度',window==='five_hour',()=>setWindow('five_hour'))}{choice('week','周额度',window==='seven_day',()=>setWindow('seven_day'))}</View>
        <View style={styles.row}>{choice('scope',allMachines?'已合并同账户设备':'仅来源设备的 Token',allMachines,()=>setAllMachines(v=>!v))}<Text style={styles.muted}>只有确认各设备共用该模型账户/额度池时，才合并设备。</Text></View>
        <Text style={styles.text}>采样间消耗 {analysis.intervals>0?analysis.points.toFixed(2):'—'} 个百分点 · 无法对应单模型 {analysis.intervals>0?analysis.ambiguousPoints.toFixed(2):'—'} 个百分点</Text>
        {history.error&&<Text accessibilityRole="alert" style={styles.muted}>{history.error}</Text>}
        {!history.error&&analysis.sampleCount<2&&<Text style={styles.muted}>{history.loading?'正在读取额度采样…':'等待至少两次有效额度采样。后台约每 5 分钟记录，关闭看板也会继续；不倒推历史额度。'}</Text>}
        <ScrollView horizontal><View>
            <View style={styles.row}>{['模型 / CLI 型号','总 Token','匹配 Token / 样本','观察消耗（百分点）','Token / 1 百分点','百分点 / 百万 Token'].map((v,i)=><Text key={v} style={[styles.cell,{fontWeight:'600'},i===0&&{width:260}]}>{v}</Text>)}</View>
            {analysis.models.map(m=><View key={m.model} style={styles.row}>
                <Text style={[styles.cell,{width:260}]}>{m.model}</Text><Text style={styles.cell}>{fmt(m.tokens)}</Text>
                <Text style={styles.cell}>{fmt(m.matchedTokens)} / {m.samples}</Text><Text style={styles.cell}>{m.samples?m.points.toFixed(2):'—'}</Text>
                <Text style={styles.cell}>{m.points>0?fmt(m.matchedTokens/m.points):'—'}</Text><Text style={styles.cell}>{m.matchedTokens>0?(m.points*1e6/m.matchedTokens).toFixed(2):'—'}</Text>
            </View>)}
        </View></ScrollView>
        {!analysis.models.length&&<Text style={styles.muted}>当前范围内没有此额度池的模型 Token 记录。</Text>}
        <Text style={styles.muted}>{analysis.sampleCount} 次采样 · {analysis.intervals} 个有效区间 · {analysis.excluded} 个重置/断档区间已排除{analysis.last?` · 最近 ${new Date(analysis.last).toLocaleString('zh-CN')}`:''}</Text>
        <Text style={styles.muted}>比例是采样区间内的观察值，不是官方计费系数。只在单一已知模型有记录且额度下降时计算；混用模型、跨采样回合、重置和长时间断档不分摊。未变化可能是四舍五入或延迟，不能视为零消耗。家庭共享、其他设备及 LMC 外调用仍可能影响结果。</Text>
        <Text style={styles.muted}>总 Token 包含缓存；缓存与输出的额度权重不同。5 小时与周额度分别观察，不相加。保留最近 90 天额度采样；本表独立选择来源和范围，不随上方会话筛选分摊账号额度。</Text>
    </View>;
}
