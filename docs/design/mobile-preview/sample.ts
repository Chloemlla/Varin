export type Mode = 'bot' | 'work';
// The original fixtures use their names as IDs. Newly created Bots have stable UUIDs.
export type Person = string;
export type Message = { who: Person | '我'; text: string; quote?: string; file?: boolean; process?: string[]; attachment?: string; choices?: string[]; answer?: string };
export type Room = { id: string; title: string; mode: Mode; people: Person[]; time: string; messages: Message[]; parent?: string; group?: boolean; pinned?: boolean; containerId?: string | null; projectId?: string | null };
export const isGroup = (room: Room) => room.group ?? room.people.length > 1;

export const people: Person[] = ['薇琳', '蓝汐', '秋澄'];
export const fileName = '合作演示提纲.md';
export const outline = [
  ['手机连上桌面', '桌面打开远程访问，手机扫码配对。在手机发一句话，再回到桌面看同一个会话。'],
  ['在群里分工', '在演示筹备群里把讲解交给蓝汐，秋澄负责记录问题。现场直接看两位成员的回复。'],
  ['留给合作方试用', '让对方选一个自己的任务，在刚连上的手机里交给薇琳。'],
];

export const initialRooms: Room[] = [
  { id: 'outline', title: '合作演示', mode: 'bot', people: ['薇琳'], time: '10:42', messages: [
    { who: '我', text: '下午的演示，改成先用手机连桌面，再讲群聊。帮我顺一下提纲。' },
    { who: '薇琳', text: '顺序换好了。先让大家看到手机和桌面里的同一段对话，再用群聊演示分工。', file: true, process: ['读取原来的演示提纲', '调整前两节顺序，保存文件'] },
    { who: '我', text: '群聊那段，蓝汐来讲吧。' },
    { who: '薇琳', text: '好，我去筹备群跟她对一下。' },
  ] },
  { id: 'group', title: '演示筹备群', mode: 'bot', people: [...people], time: '10:40', messages: [
    { who: '薇琳', text: '@蓝汐 下午你来讲群聊这段，我先演示手机连接。' },
    { who: '蓝汐', text: '收到。我会现场示范怎么 @ 一位成员，再接着它的回复往下聊。' },
    { who: '秋澄', text: '提问我来记，演示结束后整理给大家。' },
  ] },
  { id: 'notes', title: '访谈笔记', mode: 'bot', people: ['秋澄'], time: '昨天', messages: [
    { who: '我', text: '把昨天访谈里提到手机的那段摘给我。' },
    { who: '秋澄', text: '「我想出门以后也能接着看桌面上的工作。」这句话放进访谈纪要时，要署名吗？', choices: ['匿名引用', '保留署名'] },
  ] },
  { id: 'copy', title: '邀请函措辞', mode: 'bot', people: ['蓝汐'], time: '周一', messages: [
    { who: '蓝汐', text: '开头用「周五见，一起试试 Varin」就很自然。' },
  ] },
  { id: 'review', title: '演示前走查', mode: 'work', containerId: 'rehearsal', projectId: 'demo', people: ['薇琳'], time: '10:35', messages: [
    { who: '我', text: '按演示提纲走一遍手机配对和群聊。' },
    { who: '薇琳', text: '手机配对已走通，群聊走查交给了蓝汐。两部分的结果会汇总到这份提纲。', file: true, process: ['检查配对流程', '派发群聊走查'] },
  ] },
  { id: 'check', title: '群聊走查', mode: 'work', projectId: 'demo', people: ['蓝汐'], time: '10:31', parent: 'review', messages: [
    { who: '蓝汐', text: '两位成员分别收到了点名，也能直接回复对应的消息。' },
  ] },
  { id: 'feedback', title: '整理试用反馈', mode: 'work', containerId: 'followup', people: ['秋澄'], time: '昨天', messages: [
    { who: '秋澄', text: '已把试用时大家提到的问题整理好了。' },
  ] },
  { id: 'wifi', title: '检查访客 Wi-Fi', mode: 'work', people: ['薇琳'], time: '周一', messages: [
    { who: '我', text: '帮我列一下在会议室测试手机配对时要检查的网络设置。' },
  ] },
];
