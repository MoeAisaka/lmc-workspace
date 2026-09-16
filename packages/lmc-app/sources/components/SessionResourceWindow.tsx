import { apiSocket } from '@/sync/apiSocket';
import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useSession, useSessionMessages } from '@/sync/storage';
import { collectSessionResources } from '@/utils/sessionResources';
import { chooseSessionFile } from '@/utils/lmc/sessionFileActions';
import { t } from '@/text';

export function SessionResourceWindow({sessionId, onOpen, onBrowse}: {sessionId:string;onOpen:(path:string)=>void;onBrowse:()=>void}) {
    const {theme}=useUnistyles();
    const session = useSession(sessionId);
    const [scope,setScope]=React.useState<'all'|'turn'|'unseen'>('all');
    const [review,setReview]=React.useState<any>(null);
    const [reviewError,setReviewError]=React.useState('');
    const [selectedChange,setSelectedChange]=React.useState<any>(null);
    const supported=session?.metadata?.sessionCapabilities?.resourceFiles===true;
    const readReview=React.useCallback(async(before?:number)=>{
        if(!supported)return;
        try{
            const result=await apiSocket.sessionRPC<any,any>(sessionId,'resource-review',{scope,before});
            if(result?.error)throw new Error(result.error);
            setReview((old:any)=>before?{...result,entries:[...result.entries,...(old?.entries||[])]}:result);setReviewError('');
        }catch(error){setReviewError(error instanceof Error?error.message:t('lmc.resources.indexUnavailable'));}
    },[sessionId,scope,supported]);
    React.useEffect(()=>{void readReview();const timer=setInterval(()=>void readReview(),15000);return()=>clearInterval(timer);},[readReview]);
    const [busy, setBusy] = React.useState<string | null>(null);
    // The same sheet the transcript opens when a file is named in prose.
    const chooseFile = (path: string) => chooseSessionFile({ sessionId, path, onPreview: onOpen, onBusyChange: setBusy });
    const {messages,hasMoreOlder}=useSessionMessages(sessionId);
    const files=React.useMemo(()=>[...new Set([...(review?.paths||[]),...collectSessionResources(messages)])] as string[],[messages,review?.paths]);
    return <View style={{flex:1,minHeight:0}}>
        <Text style={{fontSize:12,color:theme.colors.textSecondary,paddingHorizontal:16,paddingBottom:10,lineHeight:16}}>{supported ? t('lmc.resources.headerSupported') : t('lmc.resources.headerUnsupported')}{!supported && hasMoreOlder ? t('lmc.resources.headerScrollHint') : ''}</Text>
        {busy && <Text style={{paddingHorizontal:16,color:theme.colors.textSecondary}}>{t('lmc.resources.working')}</Text>}
        {supported && <View style={{flexDirection:'row',gap:4,paddingHorizontal:10,paddingBottom:10}}>{(['all','turn','unseen'] as const).map(value=><Pressable key={value} onPress={()=>{setScope(value);setSelectedChange(null);}} style={{paddingHorizontal:10,paddingVertical:6,borderRadius:999,backgroundColor:scope===value?theme.colors.surfacePressed:'transparent'}}><Text style={{color:scope===value?theme.colors.text:theme.colors.textSecondary,fontSize:12}}>{{all:t('lmc.resources.tabAll'),turn:t('lmc.resources.tabTurn'),unseen:t('lmc.resources.tabUnseen')}[value]}</Text></Pressable>)}</View>}
        {!!reviewError&&<Text style={{padding:12,color:theme.colors.textSecondary}}>{reviewError}</Text>}
        <ScrollView contentContainerStyle={{paddingHorizontal:6,paddingBottom:12}}>
            {scope==='all' && files.length===0 && <Text style={{padding:16,color:theme.colors.textSecondary,lineHeight:20}}>{t('lmc.resources.emptyAll')}</Text>}
            {scope==='all' && files.map(file=><Pressable key={file} accessibilityRole="button" accessibilityLabel={t('lmc.resources.openFile', { path: file })} disabled={busy !== null} onPress={()=>chooseFile(file)} style={({pressed})=>({flexDirection:'row',gap:10,alignItems:'center',paddingHorizontal:10,paddingVertical:8,borderRadius:10,backgroundColor:pressed?theme.colors.surfacePressed:'transparent'})}>
                <Ionicons name="document-outline" size={20} color={theme.colors.textLink}/>
                <View style={{flex:1,minWidth:0}}><Text numberOfLines={1} style={{color:theme.colors.text,fontSize:13}}>{file.split('/').pop()}</Text><Text numberOfLines={1} style={{fontSize:11,color:theme.colors.textSecondary}}>{file}</Text></View>
            </Pressable>)}
            {scope!=='all' && <>
                <Text style={{padding:10,fontSize:11,color:theme.colors.textSecondary}}>{t('lmc.resources.reviewNote')}</Text>
                {review?.olderCursor && <Pressable onPress={()=>void readReview(review.olderCursor)}><Text style={{padding:10,color:theme.colors.textLink}}>{t('lmc.resources.loadOlder')}</Text></Pressable>}
                {(review?.entries||[]).map((entry:any)=><Pressable key={entry.revision} onPress={()=>setSelectedChange(selectedChange?.revision===entry.revision?null:entry)} style={{padding:10,borderBottomWidth:1,borderColor:theme.colors.divider}}>
                    <Text style={{color:theme.colors.text,fontSize:13}}>{{add:t('lmc.resources.kindAdd'),update:t('lmc.resources.kindUpdate'),delete:t('lmc.resources.kindDelete'),rename:t('lmc.resources.kindRename')}[entry.kind as 'add']} · {entry.path}{entry.destination?' → '+entry.destination:''}</Text>
                    {selectedChange?.revision===entry.revision && <Text selectable style={{fontFamily:'monospace',fontSize:11,lineHeight:17,paddingTop:8,color:theme.colors.textSecondary}}>{entry.patch||t('lmc.resources.noPatch')}</Text>}
                </Pressable>)}
                {!review?.entries?.length && <Text style={{padding:12,color:theme.colors.textSecondary}}>{t('lmc.resources.emptyReview')}</Text>}
                {!!review?.entries?.length && <Pressable onPress={()=>{void apiSocket.sessionRPC(sessionId,'resource-review',{viewed:review.cursor,scope}).then(()=>readReview()).catch(e=>setReviewError(e.message));}}><Text style={{padding:12,color:theme.colors.textLink}}>{t('lmc.resources.markSeen')}</Text></Pressable>}
            </>}
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={onBrowse} style={{padding:12,borderTopWidth:1,borderColor:theme.colors.divider}}><Text style={{color:theme.colors.textLink,textAlign:'center'}}>{t('lmc.resources.browseProject')}</Text></Pressable>
    </View>;
}
