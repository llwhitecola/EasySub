/**
 * Lyrics Effects Workshop — Narrative Aesthetics & Bilingual Gradient Engine (v4.2)
 *
 * Integrates:
 *   1. Narrative-Centered Master Aesthetics (5 themes · 16 director bundles · 8 kinetic anims ·
 *      5 film rhythms · smart 3-question recommendation matrix · weak conflict checks · 4-page handbook)
 *   2. Bilingual Lyrics Batch Suite (classic bright yellow + 21 MV/genre 4-corner gradients ·
 *      music-note auto-scan · secondary subtitle inheritance & -20% auto-dim · HDR dimming)
 */

const clampByte = (n) => Math.max(0, Math.min(255, Math.floor(n)));

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "").trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function dimHex(hex, factor) {
  if (!(factor < 1)) return String(hex).toUpperCase();
  const [r, g, b] = parseHex(hex);
  return toHex([r * factor, g * factor, b * factor]);
}

export function dimGradient(corners, factor) {
  return corners.map((c) => dimHex(c, factor));
}

export function representativeHex(corners) {
  const rgbs = corners.map(parseHex);
  const w = [0.34, 0.22, 0.22, 0.22];
  return toHex([0, 1, 2].map((ch) => Math.round(rgbs.reduce((s, c, i) => s + c[ch] * w[i], 0))));
}

/** Build a CSS background preview approximating a 4-corner [TL, TR, BL, BR] ASS \1vc gradient. */
export function cssCornerSwatch([tl, tr, bl, br]) {
  if (tl === tr && bl === br) return `linear-gradient(180deg, ${tl}, ${bl})`;
  if (tl === bl && tr === br) return `linear-gradient(90deg, ${tl}, ${tr})`;
  if (tl === br && tr === bl) return `linear-gradient(135deg, ${tl} 0%, ${tr} 50%, ${br} 100%)`;
  return [
    `radial-gradient(110% 110% at 0% 0%, ${tl}, transparent 68%)`,
    `radial-gradient(110% 110% at 100% 0%, ${tr}, transparent 68%)`,
    `radial-gradient(110% 110% at 0% 100%, ${bl}, transparent 68%)`,
    `linear-gradient(135deg, ${tl}, ${br})`,
  ].join(", ");
}

/* ==========================================================================
   1. 4-Corner Gradients (\1vc: [TL, TR, BL, BR] in #RRGGBB)
   ========================================================================== */
export const GRADIENTS = [
  /* ---------- 宏大叙事 · 史诗 ---------- */
  {
    id: "snyder_steel",
    key: "[史诗] 施耐德·末日钢铁",
    short: "施耐德·末日钢铁",
    group: "director",
    theme: "史诗",
    corners: ["#1696A2", "#DA6614", "#DA6614", "#1696A2"],
    scene: "史诗动作·超级英雄·神话改编",
    emotion: "壮烈·对抗·宿命·英雄暮色",
    logic: "钢青×烧橙两极对冲，砍掉中间饱和度，只留光影断层线",
    forbidden: "不可用于日常·治愈·温情·儿童向 · 不可搭配柔光动效",
  },
  {
    id: "nolan_interstellar",
    key: "[史诗] 诺兰·星际宿命",
    short: "诺兰·星际宿命",
    group: "director",
    theme: "史诗",
    corners: ["#BC943E", "#BC943E", "#122A76", "#122A76"],
    scene: "科幻史诗·宏大叙事·时间主题",
    emotion: "宏大·纵深·宿命·宇宙尺度",
    logic: "暖铜上方坠入冷宇宙蓝，纵向渐变，IMAX 纵深感",
    forbidden: "不可用于快节奏/犯罪内容 · 不可加闪烁/冲击动效",
  },
  {
    id: "villeneuve_dune",
    key: "[史诗] 维伦纽瓦·沙漠孤旅",
    short: "维伦纽瓦·沙漠孤旅",
    group: "director",
    theme: "史诗",
    corners: ["#D4B26C", "#D4B26C", "#16205C", "#16205C"],
    scene: "科幻史诗·末世孤旅·文明命运",
    emotion: "孤独·辽阔·沙尘中的渺小与宏大",
    logic: "沙金从上方沉入靛蓝深影，暗示个体与宏大命运的落差",
    forbidden: "不可用于温情·治愈内容 · 不可高饱和配色 · 不可快节奏动效",
  },
  {
    id: "kurosawa_samurai",
    key: "[史诗] 黑泽明·武士荣光",
    short: "黑泽明·武士荣光",
    group: "director",
    theme: "史诗",
    corners: ["#C69E3A", "#120E08", "#120E08", "#C69E3A"],
    scene: "历史史诗·武士道·权力与尊严",
    emotion: "荣耀·孤寂·死亡的确定性",
    logic: "烧金与墨黑对冲，金代表荣耀，黑代表必死的宿命",
    forbidden: "不可用于现代/娱乐内容 · 绝对不可加任何动效（静止即是风格）",
  },
  {
    id: "bladerunner_wasteland",
    key: "[史诗] 银翼杀手·废土孤城",
    short: "银翼杀手·废土孤城",
    group: "director",
    theme: "史诗",
    corners: ["#62A8DA", "#C67626", "#C67626", "#62A8DA"],
    scene: "反乌托邦科幻·末世孤寂·城市废墟",
    emotion: "荒废·孤独·废墟之美·人造情感",
    logic: "冰蓝全息光×沙城橙，冷暖撕裂感呈现真实与人造的对立",
    forbidden: "不可用于自然·温情内容 · 不可搭配快节奏动效",
  },

  /* ---------- 悬疑犯罪 · 幽暗 ---------- */
  {
    id: "nolan_gotham",
    key: "[犯罪] 诺兰·哥谭暗影",
    short: "诺兰·哥谭暗影",
    group: "director",
    theme: "犯罪",
    corners: ["#4E62A8", "#0C0C20", "#0C0C20", "#4E62A8"],
    scene: "犯罪惊悚·都市压迫·道德困境",
    emotion: "压迫·阴谋·城市暗面·理性崩溃",
    logic: "冷钢蓝×哥谭深暗，去掉所有暖色，只剩蓝与黑的秩序假象",
    forbidden: "不可用于自然·治愈·奇幻内容 · 不可搭配呼吸/位移动效",
  },
  {
    id: "fincher_anatomy",
    key: "[犯罪] 芬奇·心理解剖",
    short: "芬奇·心理解剖",
    group: "director",
    theme: "犯罪",
    corners: ["#708E26", "#1C2C0E", "#708E26", "#1C2C0E"],
    scene: "心理惊悚·犯罪悬疑·压抑现实",
    emotion: "病态·监视·人性腐化·冷静中的恐惧",
    logic: "毒绿黄×极暗底，工业化病变色呈现数字噪点的病态质感",
    forbidden: "不可用于日常·娱乐内容 · 绝对不可加任何动效（冷静即风格）",
  },
  {
    id: "park_vengeance",
    key: "[犯罪] 朴赞郁·暴力美学",
    short: "朴赞郁·暴力美学",
    group: "director",
    theme: "犯罪",
    corners: ["#C60C1C", "#344884", "#344884", "#C60C1C"],
    scene: "犯罪复仇·感官张力·道德倒置",
    emotion: "血腥之美·仪式感的暴力·宿命复仇",
    logic: "歌剧深红×冷钢蓝，高饱和两极制造「美丽的恐惧」视觉悖论",
    forbidden: "不可用于日常·温情·儿童内容 · 不可用柔和模糊（破坏锐利张力）",
  },
  {
    id: "scorsese_neon",
    key: "[犯罪] 斯科塞斯·纽约霓虹",
    short: "斯科塞斯·纽约霓虹",
    group: "director",
    theme: "犯罪",
    corners: ["#DA121C", "#EEBC08", "#EEBC08", "#DA121C"],
    scene: "犯罪黑帮·都市现实·街头张力",
    emotion: "街头张力·暴力美感·纽约夜色气息",
    logic: "霓虹红×出租车黄，湿沥青霓虹反光，罪与罚的真实街道",
    forbidden: "不可用于自然·清新·儿童内容 · 不可搭配柔光或治愈系动效",
  },

  /* ---------- 文艺抒情 · 孤独 ---------- */
  {
    id: "wkw_neon",
    key: "[文艺] 王家卫·霓虹遗忘",
    short: "王家卫·霓虹遗忘",
    group: "director",
    theme: "文艺",
    corners: ["#E4A226", "#B61834", "#B61834", "#E4A226"],
    scene: "都市文艺·港风情感·失忆与错过",
    emotion: "孤独·暧昧·时间的腐蚀·霓虹中的茫然",
    logic: "琥珀金×深绯红，复现过曝画面的双色光晕叠影",
    forbidden: "不可用于史诗·科幻·动作内容 · 不可降低模糊值（散焦是灵魂）",
  },
  {
    id: "tarkovsky_poem",
    key: "[文艺] 塔可夫斯基·诗意流浪",
    short: "塔可夫斯基·诗意流浪",
    group: "director",
    theme: "文艺",
    corners: ["#B2944E", "#445830", "#445830", "#B2944E"],
    scene: "文艺诗电影·精神探索·流亡与记忆",
    emotion: "湿润·静默·时间的重量·精神流亡",
    logic: "棕褐金×苔藓绿，拜占庭圣像质感配合大模糊呈现湿版散光",
    forbidden: "不可用于娱乐·快节奏内容 · 绝对不可加冲击/闪烁动效（静谧是本质）",
  },
  {
    id: "villeneuve_arrival",
    key: "[文艺] 维伦纽瓦·降临灰寂",
    short: "维伦纽瓦·降临灰寂",
    group: "director",
    theme: "文艺",
    corners: ["#308A98", "#52585C", "#52585C", "#308A98"],
    scene: "哲思科幻·语言与时间·孤绝中的理解",
    emotion: "孤绝·理解·时间非线性·静默中的震撼",
    logic: "极低饱和消色青灰，呈现冬季晨雾的朦胧距离",
    forbidden: "不可用于动作·娱乐内容 · 不可提高饱和度（消色是核心美学原则）",
  },

  /* ---------- 日常治愈 · 温情 ---------- */
  {
    id: "koreeda_gentle",
    key: "[日常] 是枝裕和·日常温柔",
    short: "是枝裕和·日常温柔",
    group: "director",
    theme: "日常",
    corners: ["#F2E8D0", "#A28052", "#A28052", "#F2E8D0"],
    scene: "家庭日常·代际情感·无声的爱",
    emotion: "细腻·无声的爱·时间里的遗忘与记住",
    logic: "晨光奶白×旧褐，日本自然光的散焦温度，减法美学",
    forbidden: "不可加任何动效（生活不表演） · 不可搭配高饱和/强对比色",
  },
  {
    id: "miyazaki_laputa",
    key: "[日常] 宫崎骏·天空之城",
    short: "宫崎骏·天空之城",
    group: "director",
    theme: "日常",
    corners: ["#62B2E4", "#EEC64E", "#EEC64E", "#62B2E4"],
    scene: "奇幻冒险·自然神性·少年成长",
    emotion: "自由·飞翔·自然的神性·手绘温度",
    logic: "水彩天蓝×向日葵金，手绘天空的透明感，光在呼吸",
    forbidden: "不可用于犯罪·惊悚·暗黑内容 · 不可搭配冲击/闪烁动效",
  },
  {
    id: "shinkai_twilight",
    key: "[日常] 新海诚·黄昏渐变",
    short: "新海诚·黄昏渐变",
    group: "director",
    theme: "日常",
    corners: ["#764EB2", "#EE8A3A", "#EE8A3A", "#764EB2"],
    scene: "青春爱情·时间流逝·错过前的最后光",
    emotion: "青涩·回忆·最后一刻的光·心碎前的温柔",
    logic: "暮色紫×晚霞橙，精准复现黄昏天空的最后色温",
    forbidden: "不可用于动作·犯罪内容 · 不可搭配冲击/快节奏动效（余晖是轻柔的）",
  },

  /* ---------- 哲思科幻 · 存在 ---------- */
  {
    id: "kubrick_gaze",
    key: "[哲思] 库布里克·冷峻凝视",
    short: "库布里克·冷峻凝视",
    group: "director",
    theme: "哲思",
    corners: ["#EEE8DA", "#C60000", "#C60000", "#EEE8DA"],
    scene: "哲思科幻·人性实验·极权寓言",
    emotion: "冷漠·精密·存在的荒诞·人与机器的边界",
    logic: "骨白×HAL红双极对角，对称美学呈现《2001》的冷峻理性",
    forbidden: "绝对不可加任何动效（凝视即是风格） · 不可用于娱乐/快节奏内容",
  },

  /* ---------- 经典与 MV 缤纷色板 (综合工具 v4.2) ---------- */
  {
    id: "classic_yellow",
    key: "[经典] 样图同款亮黄",
    short: "样图同款亮黄",
    group: "mv",
    theme: "",
    corners: ["#FFF200", "#FFF200", "#FFF200", "#FFF200"],
    scene: "经典 MV 歌词·演唱会现场·怀旧金曲",
    logic: "纯正亮黄填充配深褐柔边描边，高对比清晰醒目",
  },
  {
    id: "classic_warm_ivory",
    key: "[经典] 暖金柔光纯色",
    short: "暖金柔光纯色",
    group: "mv",
    theme: "",
    corners: ["#F2E8D0", "#F2E8D0", "#F2E8D0", "#F2E8D0"],
    scene: "抒情慢歌·片尾曲 ED·温暖叙事",
    logic: "柔和暖米金纯色配琥珀浅影，温润耐看",
  },
  {
    id: "mv_cold_testimony",
    key: "[悬疑] 冰冷证词",
    short: "冰冷证词",
    group: "mv",
    theme: "犯罪",
    corners: ["#C0C0C0", "#204050", "#C0C0C0", "#204050"],
    scene: "悬疑剧插曲·冷调独白",
    logic: "银灰×暗青蓝横向过渡",
  },
  {
    id: "mv_cordon",
    key: "[犯罪] 警戒线",
    short: "警戒线",
    group: "mv",
    theme: "犯罪",
    corners: ["#101010", "#FFD700", "#101010", "#FFD700"],
    scene: "硬核说唱·街头警匪·高张力副歌",
    logic: "深炭黑×警示黄强烈反差",
  },
  {
    id: "mv_bw",
    key: "[经典] 黑白渐变",
    short: "黑白渐变",
    group: "mv",
    theme: "",
    corners: ["#000000", "#FFFFFF", "#000000", "#FFFFFF"],
    scene: "黑白影像·极简实验 MV",
    logic: "纯粹光影明暗渐变",
  },
  {
    id: "mv_gold_green",
    key: "[清新] 青金翠影",
    short: "青金翠影",
    group: "mv",
    theme: "",
    corners: ["#25A9B7", "#B5B725", "#25A9B7", "#86B725"],
    scene: "国风流行·森林夏日 MV",
    logic: "湖青×暖金绿四角流转",
  },
  {
    id: "mv_violet_amber",
    key: "[潮流] 星紫流金",
    short: "星紫流金",
    group: "mv",
    theme: "",
    corners: ["#B469FF", "#FF901E", "#B469FF", "#FF901E"],
    scene: "流行电音·都市夜景",
    logic: "霓虹紫×暖橙横向碰撞",
  },
  {
    id: "mv_red_blue_diag",
    key: "[张力] 红蓝对角",
    short: "红蓝对角",
    group: "mv",
    theme: "",
    corners: ["#0000FF", "#FF0000", "#FF0000", "#0000FF"],
    scene: "摇滚现场·双人对唱",
    logic: "冰火红蓝对角交锋",
  },
  {
    id: "mv_summer_neon",
    key: "[活力] 夏日霓虹",
    short: "夏日霓虹",
    group: "mv",
    theme: "",
    corners: ["#FF1493", "#00FF00", "#00FFFF", "#FF8000"],
    scene: "夏日派对·电子舞曲·高燃快剪",
    logic: "四极全彩霓虹迸发",
  },
  {
    id: "mv_electro_gold",
    key: "[活力] 电光紫金",
    short: "电光紫金",
    group: "mv",
    theme: "",
    corners: ["#8A2BE2", "#FFD700", "#FFD700", "#8A2BE2"],
    scene: "K-Pop 舞台·华丽副歌",
    logic: "电光紫×璀璨金对角辉映",
  },
  {
    id: "mv_blood_grail",
    key: "[暗黑] 鲜血圣杯",
    short: "鲜血圣杯",
    group: "mv",
    theme: "犯罪",
    corners: ["#C0C0C0", "#8B0000", "#C0C0C0", "#8B0000"],
    scene: "哥特摇滚·暗黑奇幻 OST",
    logic: "冷银×暗血红庄严渐变",
  },
  {
    id: "mv_underworld",
    key: "[暗黑] 冥界幽火",
    short: "冥界幽火",
    group: "mv",
    theme: "",
    corners: ["#4B0082", "#00CED1", "#4B0082", "#00CED1"],
    scene: "奇幻电子·神秘氛围插曲",
    logic: "靛紫×幽青冷火交织",
  },
  {
    id: "mv_unicorn",
    key: "[梦幻] 糖果独角兽",
    short: "糖果独角兽",
    group: "mv",
    theme: "日常",
    corners: ["#FF69B4", "#00BFFF", "#FF69B4", "#00BFFF"],
    scene: "甜美偶像·恋爱轻喜剧 OP",
    logic: "樱花粉×晴空蓝甜美渐变",
  },
  {
    id: "mv_aurora",
    key: "[梦幻] 极光幻境",
    short: "极光幻境",
    group: "mv",
    theme: "",
    corners: ["#BA55D3", "#00FF7F", "#BA55D3", "#00FF7F"],
    scene: "空灵女声·北欧极光旅拍",
    logic: "兰花紫×春极光绿流彩",
  },
  {
    id: "mv_rose_champagne",
    key: "[优雅] 玫瑰香槟",
    short: "玫瑰香槟",
    group: "mv",
    theme: "文艺",
    corners: ["#B76E79", "#F7E7CE", "#B76E79", "#F7E7CE"],
    scene: "爵士慢歌·法式浪漫插曲",
    logic: "干燥玫瑰×香槟金丝绒质感",
  },
  {
    id: "mv_sunset",
    key: "[自然] 落日余晖",
    short: "落日余晖",
    group: "mv",
    theme: "日常",
    corners: ["#FF8C00", "#8B0000", "#FF8C00", "#8B0000"],
    scene: "公路旅行·民谣吉他尾奏",
    logic: "落日熔金渐入晚霞深红",
  },
  {
    id: "mv_deep_emerald",
    key: "[海洋] 深海翡翠",
    short: "深海翡翠",
    group: "mv",
    theme: "",
    corners: ["#008080", "#7FFFD4", "#008080", "#7FFFD4"],
    scene: "海洋自然纪录·治愈纯音乐",
    logic: "深海青×碧玉波光",
  },
  {
    id: "mv_black_gold",
    key: "[高级] 黑金奢华",
    short: "黑金奢华",
    group: "mv",
    theme: "史诗",
    corners: ["#1A1A1A", "#FFD700", "#1A1A1A", "#FFD700"],
    scene: "片头主题曲·颁奖礼混剪",
    logic: "曜石黑×鎏金高贵质感",
  },
  {
    id: "mv_mint_lemon",
    key: "[清新] 薄荷柠檬",
    short: "薄荷柠檬",
    group: "mv",
    theme: "日常",
    corners: ["#98FF98", "#FFF44F", "#98FF98", "#FFF44F"],
    scene: "校园夏日·清新 Vlog 插曲",
    logic: "薄荷绿×柠檬黄沁凉通透",
  },
  {
    id: "mv_amber_dusk",
    key: "[复古] 琥珀暮色",
    short: "琥珀暮色",
    group: "mv",
    theme: "文艺",
    corners: ["#FFBF00", "#800020", "#FFBF00", "#800020"],
    scene: "胶片老歌·港式复古金曲",
    logic: "琥珀金×勃艮第酒红浓郁胶片感",
  },
  {
    id: "mv_cyberpunk",
    key: "[科幻] 赛博朋克",
    short: "赛博朋克",
    group: "mv",
    theme: "",
    corners: ["#00FFFF", "#FF00FF", "#00FFFF", "#FF00FF"],
    scene: "赛博电子·未来都市夜行",
    logic: "青色激光×洋红霓虹",
  },
  {
    id: "mv_glacier",
    key: "[冰雪] 冰川蓝光",
    short: "冰川蓝光",
    group: "mv",
    theme: "",
    corners: ["#A5F2F3", "#E0E8FF", "#A5F2F3", "#E0E8FF"],
    scene: "冬日恋歌·清澈钢琴独奏",
    logic: "冰晶浅青×霜白纯净微光",
  },
];

export const GRADIENT_BY_ID = new Map(GRADIENTS.map((g) => [g.id, g]));

/* ==========================================================================
   2. Kinetic Animations (\t() scaled by film rhythm)
   ========================================================================== */
export const ANIMS = [
  {
    id: "none",
    name: "无动效（静止凝视）",
    short: "静止",
    fitTheme: "",
    fit: "哲思·犯罪(芬奇)·日常(是枝裕和)·史诗(黑泽明)",
    forbidden: "静止本身就是风格语言，不要因为空着就乱加动效",
  },
  {
    id: "snyder_push",
    name: "施耐德 · 慢推史诗",
    short: "慢推史诗",
    fitTheme: "史诗",
    fit: "史诗·宏大叙事",
    forbidden: "不可用于文艺·日常·治愈场景",
  },
  {
    id: "nolan_dissolve",
    name: "诺兰 · 纵深溶解",
    short: "纵深溶解",
    fitTheme: "史诗",
    fit: "史诗·科幻·时间主题",
    forbidden: "不可用于犯罪·快节奏场景",
  },
  {
    id: "wkw_afterimage",
    name: "王家卫 · 残影记忆",
    short: "残影记忆",
    fitTheme: "文艺",
    fit: "文艺·港风·回忆闪回",
    forbidden: "不可用于史诗·动作·快节奏场景",
  },
  {
    id: "shinkai_focus",
    name: "新海诚 · 镜头聚焦",
    short: "镜头聚焦",
    fitTheme: "日常",
    fit: "日常·青春·情感细腻",
    forbidden: "不可用于犯罪·暴力·史诗宏大场景",
  },
  {
    id: "breath_glow",
    name: "呼吸光晕",
    short: "呼吸光晕",
    fitTheme: "文艺",
    fit: "文艺·诗意·自然奇幻",
    forbidden: "不可用于犯罪·快节奏·冲击场景",
  },
  {
    id: "neon_flicker",
    name: "霓虹闪烁",
    short: "霓虹闪烁",
    fitTheme: "犯罪",
    fit: "犯罪·都市霓虹",
    forbidden: "不可用于文艺·日常·治愈场景",
  },
  {
    id: "impact_flash",
    name: "冲击闪入",
    short: "冲击闪入",
    fitTheme: "犯罪",
    fit: "犯罪·暴力美学·高强度冲击",
    forbidden: "不可用于文艺·日常·哲思场景，不可超过每两秒一次",
  },
];

export const ANIM_BY_ID = new Map(ANIMS.map((a) => [a.id, a]));

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const ramp = (elapsed, t1, t2) => (elapsed <= t1 ? 0 : elapsed >= t2 ? 1 : (elapsed - t1) / Math.max(1, t2 - t1));

/**
 * Sample kinetic animation at `elapsedMs` (relative to cue start) for 60fps Canvas WYSIWYG rendering.
 * Returns { scale, blur, alpha, activeWindowMs }.
 */
export function sampleAnim(animId, mult = 1, baseBlur = 2.5, elapsedMs = Infinity) {
  const m = Number.isFinite(mult) && mult > 0 ? Math.max(0.2, Math.min(3, mult)) : 1;
  if (!animId || animId === "none") {
    return { scale: 1, blur: baseBlur, alpha: 1, activeWindowMs: 0 };
  }
  const s = (t) => Math.max(0, Math.floor(t * m));
  // If no timestamp was supplied (e.g. static thumbnail), render crisp steady-state!
  if (!Number.isFinite(elapsedMs)) {
    return { scale: 1, blur: baseBlur, alpha: 1, activeWindowMs: 0 };
  }

  switch (animId) {
    case "snyder_push": {
      const end = Math.max(1, s(600));
      const p = ramp(elapsedMs, 0, end);
      return { scale: lerp(1.06, 1, p), blur: lerp(2, 1, p), alpha: 1, activeWindowMs: end };
    }
    case "nolan_dissolve": {
      const end = Math.max(1, s(900));
      const p = ramp(elapsedMs, 0, end);
      return { scale: lerp(1.03, 1, p), blur: lerp(3, 1.5, p), alpha: 1, activeWindowMs: end };
    }
    case "wkw_afterimage": {
      const a2 = Math.max(1, s(500));
      const b1 = s(1800);
      const b2 = Math.max(b1 + 1, s(2400));
      const blur = elapsedMs < a2
        ? lerp(5, 1.5, ramp(elapsedMs, 0, a2))
        : elapsedMs < b1
          ? 1.5
          : lerp(1.5, 4, ramp(elapsedMs, b1, b2));
      return { scale: 1, blur, alpha: 1, activeWindowMs: b2 };
    }
    case "shinkai_focus": {
      const end = Math.max(1, s(400));
      const p = ramp(elapsedMs, 0, end);
      return { scale: lerp(0.96, 1, p), blur: lerp(3, 1.5, p), alpha: 1, activeWindowMs: end };
    }
    case "breath_glow": {
      const a2 = Math.max(1, s(900));
      const b2 = Math.max(a2 + 1, s(1800));
      const blur = elapsedMs <= a2
        ? lerp(baseBlur, 4, ramp(elapsedMs, 0, a2))
        : lerp(4, 1.5, ramp(elapsedMs, a2, b2));
      return { scale: 1, blur, alpha: 1, activeWindowMs: b2 };
    }
    case "neon_flicker": {
      const t1 = Math.max(1, s(100));
      const t2 = Math.max(t1 + 1, s(200));
      const t3 = Math.max(t2 + 1, s(320));
      const t4 = Math.max(t3 + 1, s(500));
      const a55 = (255 - 0x55) / 255;
      const a77 = (255 - 0x77) / 255;
      let alpha = 1;
      if (elapsedMs < t1) alpha = lerp(1, a55, ramp(elapsedMs, 0, t1));
      else if (elapsedMs < t2) alpha = lerp(a55, 1, ramp(elapsedMs, t1, t2));
      else if (elapsedMs < t3) alpha = lerp(1, a77, ramp(elapsedMs, t2, t3));
      else if (elapsedMs < t4) alpha = lerp(a77, 1, ramp(elapsedMs, t3, t4));
      return { scale: 1, blur: baseBlur, alpha, activeWindowMs: t4 };
    }
    case "impact_flash": {
      const end = Math.max(1, s(180));
      const p = ramp(elapsedMs, 0, end);
      const a88 = (255 - 0x88) / 255;
      return { scale: lerp(1.28, 1, p), blur: lerp(8, 0.5, p), alpha: lerp(a88, 1, p), activeWindowMs: end };
    }
    default:
      return { scale: 1, blur: baseBlur, alpha: 1, activeWindowMs: 0 };
  }
}

/* ==========================================================================
   3. Rhythms, Fades, Blurs, Outlines, Shadows, HDR
   ========================================================================== */
export const RHYTHMS = [
  { id: "poetic", name: "极缓 · 诗电影长镜头", short: "极缓 2.0×", fadeMult: 2.0, blurShift: 2, ref: "塔可夫斯基 / 是枝裕和" },
  { id: "gentle", name: "舒缓 · 日常治愈叙事", short: "舒缓 1.5×", fadeMult: 1.5, blurShift: 1, ref: "宫崎骏 / 新海诚" },
  { id: "standard", name: "标准 · 常规剧情叙事", short: "标准 1.0×", fadeMult: 1.0, blurShift: 0, ref: "通用默认" },
  { id: "tight", name: "紧凑 · 犯罪动作快切", short: "紧凑 0.6×", fadeMult: 0.6, blurShift: -1, ref: "芬奇 / 朴赞郁" },
  { id: "mv_fast", name: "极快 · MV 高燃快剪", short: "极快 0.3×", fadeMult: 0.3, blurShift: -2, ref: "MV / 高燃副歌" },
];
export const RHYTHM_BY_ID = new Map(RHYTHMS.map((r) => [r.id, r]));

export const FADES = [
  { id: "none", name: "无淡入淡出", fadeIn: 0, fadeOut: 0 },
  { id: "fast", name: "快速 (100 / 100ms)", fadeIn: 100, fadeOut: 100 },
  { id: "soft", name: "柔和 (150 / 150ms)", fadeIn: 150, fadeOut: 150 },
  { id: "standard", name: "标准 (200 / 200ms)", fadeIn: 200, fadeOut: 200 },
  { id: "slow", name: "缓慢 (400 / 400ms)", fadeIn: 400, fadeOut: 400 },
  { id: "cinema", name: "电影感 (300进 / 500出)", fadeIn: 300, fadeOut: 500 },
  { id: "ritual", name: "仪式感 (0进 / 600出)", fadeIn: 0, fadeOut: 600 },
  { id: "in_only", name: "仅淡入 (250ms)", fadeIn: 250, fadeOut: 0 },
  { id: "out_only", name: "仅淡出 (250ms)", fadeIn: 0, fadeOut: 250 },
];
export const FADE_BY_ID = new Map(FADES.map((f) => [f.id, f]));

export const BLURS = [
  { id: "0", name: "无模糊 (0)", value: 0 },
  { id: "0.5", name: "0.5 (微锐)", value: 0.5 },
  { id: "1", name: "1.0 (锐利)", value: 1.0 },
  { id: "1.5", name: "1.5 (清透)", value: 1.5 },
  { id: "2", name: "2.0 (均衡)", value: 2.0 },
  { id: "2.5", name: "2.5 (歌词标准)", value: 2.5 },
  { id: "3", name: "3.0 (柔光)", value: 3.0 },
  { id: "4", name: "4.0 (散焦)", value: 4.0 },
  { id: "5", name: "5.0 (残影)", value: 5.0 },
];

export const OUTLINES = [
  { id: "warm_brown", name: "经典褐棕 (样图歌词)", color: "#463C37", width: 3.0 },
  { id: "steel_navy", name: "钢铁深蓝 (施耐德/诺兰)", color: "#18080A", width: 2.8 },
  { id: "cosmos_black", name: "深空暗紫 (诺兰星际)", color: "#0A0408", width: 2.8 },
  { id: "gotham_slate", name: "哥谭暗褐 (诺兰犯罪)", color: "#201812", width: 2.6 },
  { id: "fincher_green", name: "数字暗绿 (芬奇)", color: "#060E06", width: 2.4 },
  { id: "wkw_crimson", name: "霓虹深绯 (王家卫)", color: "#100010", width: 2.8 },
  { id: "anime_navy", name: "手绘深蓝 (宫崎骏/新海诚)", color: "#000A1A", width: 2.8 },
  { id: "earth_umber", name: "自然暗褐 (是枝裕和/老塔)", color: "#100C08", width: 2.6 },
  { id: "dune_ochre", name: "沙尘深棕 (维伦纽瓦)", color: "#30180A", width: 2.8 },
  { id: "pure_black", name: "纯黑描边 (通用)", color: "#000000", width: 2.8 },
  { id: "none", name: "透明 (无描边)", color: "#000000", width: 0 },
];
export const OUTLINE_BY_ID = new Map(OUTLINES.map((o) => [o.id, o]));

export const SHADOWS = [
  { id: "soft_black", name: "纯黑半透 (通用)", color: "#000000", opacity: 0.467, depth: 1.2 },
  { id: "snyder_teal", name: "暗青半透 (施耐德)", color: "#040C1A", opacity: 0.333, depth: 1.6 },
  { id: "nolan_space", name: "深空冷蓝 (诺兰)", color: "#000A30", opacity: 0.40, depth: 1.6 },
  { id: "solid_black", name: "暗底实影 (芬奇/库布里克)", color: "#000000", opacity: 1.0, depth: 1.2 },
  { id: "neon_crimson", name: "霓虹暗红 (王家卫/老马)", color: "#180010", opacity: 0.40, depth: 1.8 },
  { id: "shinkai_plum", name: "暮紫柔影 (新海诚/朴赞郁)", color: "#1A0010", opacity: 0.40, depth: 1.5 },
  { id: "warm_amber", name: "暖米浅影 (是枝裕和/宫崎骏)", color: "#604020", opacity: 0.267, depth: 1.4 },
  { id: "dune_shadow", name: "沙尘深褐 (维伦纽瓦)", color: "#30180A", opacity: 0.333, depth: 1.6 },
  { id: "none", name: "无阴影", color: "#000000", opacity: 0, depth: 0 },
];
export const SHADOW_BY_ID = new Map(SHADOWS.map((s) => [s.id, s]));

export const HDR_LEVELS = [
  { id: "off", name: "关闭 (SDR 100%)", factor: 1.0 },
  { id: "light", name: "轻度压暗 (90%)", factor: 0.90 },
  { id: "std", name: "标准 HDR (75%)", factor: 0.75 },
  { id: "strong", name: "杜比强压暗 (60%)", factor: 0.60 },
];
export const HDR_BY_ID = new Map(HDR_LEVELS.map((h) => [h.id, h]));

/* ==========================================================================
   4. 16 Director Master Bundles + 2 Classic MV Bundles
   ========================================================================== */
export const BUNDLES = [
  {
    id: "b_snyder",
    theme: "史诗",
    name: "施耐德 · 末日钢铁",
    desc: "史诗动作·英雄对抗·神话气质",
    gradId: "snyder_steel",
    blurId: "2",
    fadeId: "cinema",
    outlineId: "steel_navy",
    shadowId: "snyder_teal",
    animId: "snyder_push",
    noAnim: false,
    forbidden: "禁止用于日常/治愈/温情内容 · 禁止搭配柔光模糊动效",
  },
  {
    id: "b_nolan_space",
    theme: "史诗",
    name: "诺兰 · 星际宿命",
    desc: "科幻史诗·时间命运·宇宙尺度叙事",
    gradId: "nolan_interstellar",
    blurId: "2.5",
    fadeId: "slow",
    outlineId: "cosmos_black",
    shadowId: "nolan_space",
    animId: "nolan_dissolve",
    noAnim: false,
    forbidden: "禁止用于犯罪/快节奏内容 · 禁止加闪烁/冲击动效",
  },
  {
    id: "b_villeneuve_dune",
    theme: "史诗",
    name: "维伦纽瓦 · 沙漠孤旅",
    desc: "科幻史诗·孤独宏大·沙尘中的渺小",
    gradId: "villeneuve_dune",
    blurId: "3",
    fadeId: "slow",
    outlineId: "dune_ochre",
    shadowId: "dune_shadow",
    animId: "nolan_dissolve",
    noAnim: false,
    forbidden: "禁止用于温情/治愈内容 · 禁止高饱和配色 · 禁止快节奏动效",
  },
  {
    id: "b_kurosawa",
    theme: "史诗",
    name: "黑泽明 · 武士荣光",
    desc: "历史史诗·武士道·荣耀与孤寂",
    gradId: "kurosawa_samurai",
    blurId: "1.5",
    fadeId: "slow",
    outlineId: "pure_black",
    shadowId: "solid_black",
    animId: "none",
    noAnim: true,
    forbidden: "绝对禁止任何动效（静止是黑泽明的风格语言） · 禁止用于现代/娱乐内容",
  },
  {
    id: "b_bladerunner",
    theme: "史诗",
    name: "银翼杀手 · 废土孤城",
    desc: "反乌托邦科幻·荒废之美·人造情感",
    gradId: "bladerunner_wasteland",
    blurId: "3",
    fadeId: "cinema",
    outlineId: "dune_ochre",
    shadowId: "nolan_space",
    animId: "breath_glow",
    noAnim: false,
    forbidden: "禁止用于自然/温情内容 · 禁止搭配快节奏动效",
  },
  {
    id: "b_nolan_gotham",
    theme: "犯罪",
    name: "诺兰 · 哥谭暗影",
    desc: "犯罪惊悚·都市压迫·道德困境",
    gradId: "nolan_gotham",
    blurId: "1.5",
    fadeId: "ritual",
    outlineId: "gotham_slate",
    shadowId: "nolan_space",
    animId: "none",
    noAnim: true,
    forbidden: "禁止用于自然/治愈/奇幻内容 · 禁止搭配呼吸/位移动效",
  },
  {
    id: "b_fincher",
    theme: "犯罪",
    name: "芬奇 · 心理解剖",
    desc: "心理悬疑·压抑犯罪·冷静中的恐惧",
    gradId: "fincher_anatomy",
    blurId: "1.5",
    fadeId: "none",
    outlineId: "fincher_green",
    shadowId: "solid_black",
    animId: "none",
    noAnim: true,
    forbidden: "绝对禁止任何动效（冷静即风格） · 禁止淡入（芬奇冷静切入）",
  },
  {
    id: "b_park",
    theme: "犯罪",
    name: "朴赞郁 · 暴力美学",
    desc: "犯罪复仇·感官张力·美丽的恐惧",
    gradId: "park_vengeance",
    blurId: "1",
    fadeId: "none",
    outlineId: "pure_black",
    shadowId: "shinkai_plum",
    animId: "impact_flash",
    noAnim: false,
    forbidden: "禁止用于日常/温情/儿童内容 · 禁止柔光模糊 · 禁止淡入（突然出现是风格）",
  },
  {
    id: "b_scorsese",
    theme: "犯罪",
    name: "斯科塞斯 · 纽约霓虹",
    desc: "犯罪黑帮·都市现实·街头张力",
    gradId: "scorsese_neon",
    blurId: "2",
    fadeId: "standard",
    outlineId: "steel_navy",
    shadowId: "neon_crimson",
    animId: "neon_flicker",
    noAnim: false,
    forbidden: "禁止用于自然/清新/儿童内容 · 禁止搭配柔光治愈系动效",
  },
  {
    id: "b_wkw",
    theme: "文艺",
    name: "王家卫 · 霓虹遗忘",
    desc: "港风文艺·孤独暧昧·时间里的错过",
    gradId: "wkw_neon",
    blurId: "5",
    fadeId: "cinema",
    outlineId: "wkw_crimson",
    shadowId: "neon_crimson",
    animId: "wkw_afterimage",
    noAnim: false,
    forbidden: "禁止用于史诗/科幻/动作内容 · 禁止降低模糊值（散焦是灵魂）",
  },
  {
    id: "b_tarkovsky",
    theme: "文艺",
    name: "塔可夫斯基 · 诗意流浪",
    desc: "文艺诗电影·精神探索·时间的重量",
    gradId: "tarkovsky_poem",
    blurId: "4",
    fadeId: "slow",
    outlineId: "earth_umber",
    shadowId: "warm_amber",
    animId: "breath_glow",
    noAnim: false,
    forbidden: "禁止用于娱乐/快节奏内容 · 绝对禁止冲击/闪烁动效",
  },
  {
    id: "b_arrival",
    theme: "文艺",
    name: "维伦纽瓦 · 降临灰寂",
    desc: "哲思科幻·语言与时间·孤绝中的理解",
    gradId: "villeneuve_arrival",
    blurId: "4",
    fadeId: "slow",
    outlineId: "dune_ochre",
    shadowId: "dune_shadow",
    animId: "breath_glow",
    noAnim: false,
    forbidden: "禁止用于动作/娱乐内容 · 禁止提高饱和度（消色是核心）",
  },
  {
    id: "b_koreeda",
    theme: "日常",
    name: "是枝裕和 · 日常温柔",
    desc: "家庭日常·细腻情感·无声的爱",
    gradId: "koreeda_gentle",
    blurId: "3",
    fadeId: "soft",
    outlineId: "earth_umber",
    shadowId: "warm_amber",
    animId: "none",
    noAnim: true,
    forbidden: "绝对禁止任何动效（生活不表演） · 禁止搭配高饱和/强对比色",
  },
  {
    id: "b_miyazaki",
    theme: "日常",
    name: "宫崎骏 · 天空之城",
    desc: "奇幻冒险·自然神性·少年成长",
    gradId: "miyazaki_laputa",
    blurId: "2.5",
    fadeId: "standard",
    outlineId: "anime_navy",
    shadowId: "warm_amber",
    animId: "breath_glow",
    noAnim: false,
    forbidden: "禁止用于犯罪/惊悚/暗黑内容 · 禁止搭配冲击/闪烁动效",
  },
  {
    id: "b_shinkai",
    theme: "日常",
    name: "新海诚 · 黄昏渐变",
    desc: "青春爱情·时间流逝·错过前的最后光",
    gradId: "shinkai_twilight",
    blurId: "2.5",
    fadeId: "soft",
    outlineId: "anime_navy",
    shadowId: "shinkai_plum",
    animId: "shinkai_focus",
    noAnim: false,
    forbidden: "禁止用于动作/犯罪内容 · 禁止搭配冲击/快节奏动效",
  },
  {
    id: "b_kubrick",
    theme: "哲思",
    name: "库布里克 · 冷峻凝视",
    desc: "哲思科幻·人性实验·存在的荒诞",
    gradId: "kubrick_gaze",
    blurId: "1",
    fadeId: "slow",
    outlineId: "pure_black",
    shadowId: "solid_black",
    animId: "none",
    noAnim: true,
    forbidden: "绝对禁止任何动效（凝视即是风格） · 禁止用于娱乐/快节奏内容",
  },
];
export const BUNDLE_BY_ID = new Map(BUNDLES.map((b) => [b.id, b]));

/* ==========================================================================
   5. Creative Guide Matrix (v4.2 [fix1] verified)
   ========================================================================== */
export const GUIDE_GENRES = [
  { id: "epic", label: "史诗 · 英雄 · 历史" },
  { id: "crime", label: "犯罪 · 悬疑 · 复仇" },
  { id: "art", label: "文艺 · 孤独 · 记忆" },
  { id: "daily", label: "日常 · 治愈 · 青春" },
  { id: "scifi", label: "科幻 · 哲思 · 未来" },
];

export const GUIDE_MOODS = [
  { id: "grand", label: "壮烈 · 宏大 · 荣耀" },
  { id: "tense", label: "压抑 · 冷峻 · 紧张" },
  { id: "lonely", label: "孤独 · 暧昧 · 疏离" },
  { id: "warm", label: "温柔 · 细腻 · 治愈" },
  { id: "stoic", label: "冷静 · 荒诞 · 孤绝" },
];

export const GUIDE_MAP = {
  epic: {
    grand: ["b_snyder", "b_kurosawa", "b_nolan_space"],
    tense: ["b_nolan_space", "b_villeneuve_dune", "b_nolan_gotham"],
    lonely: ["b_villeneuve_dune", "b_bladerunner", "b_kurosawa"],
    warm: ["b_nolan_space", "b_miyazaki", "b_shinkai"],
    stoic: ["b_kubrick", "b_villeneuve_dune", "b_kurosawa"],
  },
  crime: {
    grand: ["b_scorsese", "b_park", "b_nolan_gotham"],
    tense: ["b_fincher", "b_nolan_gotham", "b_park"],
    lonely: ["b_fincher", "b_nolan_gotham", "b_wkw"],
    warm: ["b_nolan_gotham", "b_fincher", "b_wkw"],
    stoic: ["b_fincher", "b_nolan_gotham", "b_kubrick"],
  },
  art: {
    grand: ["b_tarkovsky", "b_arrival", "b_wkw"],
    tense: ["b_arrival", "b_tarkovsky", "b_wkw"],
    lonely: ["b_wkw", "b_tarkovsky", "b_arrival"],
    warm: ["b_wkw", "b_tarkovsky", "b_shinkai"],
    stoic: ["b_arrival", "b_tarkovsky", "b_kubrick"],
  },
  daily: {
    grand: ["b_miyazaki", "b_nolan_space", "b_kurosawa"],
    tense: ["b_shinkai", "b_koreeda", "b_wkw"],
    lonely: ["b_shinkai", "b_wkw", "b_koreeda"],
    warm: ["b_koreeda", "b_miyazaki", "b_shinkai"],
    stoic: ["b_koreeda", "b_shinkai", "b_arrival"],
  },
  scifi: {
    grand: ["b_nolan_space", "b_villeneuve_dune", "b_bladerunner"],
    tense: ["b_kubrick", "b_fincher", "b_bladerunner"],
    lonely: ["b_bladerunner", "b_arrival", "b_villeneuve_dune"],
    warm: ["b_nolan_space", "b_villeneuve_dune", "b_miyazaki"],
    stoic: ["b_kubrick", "b_arrival", "b_nolan_space"],
  },
};

/* ==========================================================================
   6. Weak Aesthetic Conflict Check ([fix5]) & Style Compiler ([fix2], [fix3])
   ========================================================================== */
export function checkAestheticConflict({ bundleId, gradId, animId }) {
  if (!animId || animId === "none") return null;
  const anim = ANIM_BY_ID.get(animId);
  const grad = GRADIENT_BY_ID.get(gradId);
  const bundle = BUNDLE_BY_ID.get(bundleId);
  if (!anim) return null;

  if (bundle?.noAnim) {
    return {
      title: `「${bundle.name}」主张静止克制，当前启用了「${anim.short}」`,
      detail: `${bundle.forbidden}（并非强制禁止，有意为之的审美反差可继续应用）`,
    };
  }
  if (grad?.theme && anim.fitTheme && grad.theme !== anim.fitTheme) {
    return {
      title: `色板母题 [${grad.theme}] 与动效适配 [${anim.fitTheme}] 存在跨调性反差`,
      detail: `动效禁忌：${anim.forbidden}（并非强制禁止，顶级审美亦允许有意反差）`,
    };
  }
  return null;
}

export function resolveBlurWithRhythm(blurId, rhythmId) {
  const idx = Math.max(0, BLURS.findIndex((b) => b.id === String(blurId)));
  const shift = RHYTHM_BY_ID.get(rhythmId)?.blurShift ?? 0;
  const next = Math.max(0, Math.min(BLURS.length - 1, idx + shift));
  return BLURS[next].value;
}

/**
 * Compile a workshop configuration into an EasySub style object ready for global or per-cue application.
 */
export function compileLyricsStyle(cfg, baseStyle) {
  const grad = GRADIENT_BY_ID.get(cfg.gradId) || GRADIENTS[0];
  const rhythm = RHYTHM_BY_ID.get(cfg.rhythmId) || RHYTHMS[2];
  const fade = FADE_BY_ID.get(cfg.fadeId) || FADES[0];
  const outline = OUTLINE_BY_ID.get(cfg.outlineId) || OUTLINES[0];
  const shadow = SHADOW_BY_ID.get(cfg.shadowId) || SHADOWS[0];
  const hdrFactor = HDR_BY_ID.get(cfg.hdrId)?.factor ?? 1.0;

  const mainCorners = dimGradient(grad.corners, hdrFactor);
  const subFactor = cfg.subInherit !== false && cfg.subAutoDim !== false ? 0.8 : 1.0;
  const subCorners = dimGradient(mainCorners, subFactor);

  const isSolid = (c) => c[0] === c[1] && c[1] === c[2] && c[2] === c[3];
  const mainRep = representativeHex(mainCorners);
  const subRep = representativeHex(subCorners);

  const zhFont = cfg.font === "__keep__" ? (baseStyle?.zh?.font || "【嵐】蜘蛛体") : (cfg.font || "【嵐】蜘蛛体");
  const enFont = cfg.font === "__keep__" ? (baseStyle?.en?.font || "【嵐】蜘蛛体") : (cfg.font || "【嵐】蜘蛛体");
  const zhSize = cfg.font === "__keep__" ? (baseStyle?.zh?.size || 68) : 68;
  const enSize = cfg.font === "__keep__" ? (baseStyle?.en?.size || 45) : 45;

  const blurVal = resolveBlurWithRhythm(cfg.blurId, cfg.rhythmId);
  const fadeIn = Math.floor(fade.fadeIn * rhythm.fadeMult);
  const fadeOut = Math.floor(fade.fadeOut * rhythm.fadeMult);
  const inherit = cfg.subInherit !== false;

  return {
    order: "zh_top",
    margin_v: Number.isFinite(cfg.marginV) ? cfg.marginV : 30,
    line_gap: Number.isFinite(cfg.lineGap) ? cfg.lineGap : 9,
    blur: blurVal,
    fade_in_ms: fadeIn,
    fade_out_ms: fadeOut,
    anim: cfg.animId || "none",
    anim_mult: rhythm.fadeMult,
    sub_anim: inherit,
    ycbcr_matrix: "None",
    box_mode: false,
    box_color: "#000000",
    box_opacity: 0.5,
    zh: {
      style_name: "Lyrics",
      font: zhFont,
      size: zhSize,
      color: mainRep,
      gradient: isSolid(mainCorners) ? null : mainCorners,
      secondary_color: "#000000",
      outline_color: outline.color,
      outline: outline.width,
      back_color: shadow.color,
      back_opacity: shadow.opacity,
      shadow: shadow.depth,
      scale_x: 100,
      margin_l: 10,
      margin_r: 10,
      bold: false,
      italic: false,
    },
    en: {
      style_name: "LyricsENG",
      font: enFont,
      size: enSize,
      color: subRep,
      gradient: isSolid(subCorners) ? null : subCorners,
      secondary_color: "#000000",
      outline_color: inherit ? outline.color : (baseStyle?.en?.outline_color || outline.color),
      outline: inherit ? outline.width : (baseStyle?.en?.outline ?? 2.4),
      back_color: inherit ? shadow.color : (baseStyle?.en?.back_color || "#000000"),
      back_opacity: inherit ? shadow.opacity : (baseStyle?.en?.back_opacity ?? 0.6),
      shadow: inherit ? shadow.depth : (baseStyle?.en?.shadow ?? 1.0),
      scale_x: 100,
      margin_l: 10,
      margin_r: 10,
      bold: false,
      italic: false,
    },
  };
}

/* ==========================================================================
   7. 4-Page Narrative Aesthetics Handbook ([fix4])
   ========================================================================== */
export const HANDBOOK_PAGES = [
  {
    id: "principles",
    title: "底层四原则",
    subtitle: "字幕是叙事与情绪的延伸，形式永远服务内容",
    items: [
      {
        badge: "原则 01",
        head: "叙事优先",
        body: "所有颜色、渐变与动效必须 100% 匹配影片题材、情绪与核心气质。绝不为了「好看」硬加特效——这是电影级审美与业余炫技的分水岭。",
      },
      {
        badge: "原则 02",
        head: "风格统一",
        body: "一部影片的字幕必须有完整自洽的美学逻辑，不能既有冷峻科幻风、又混搭治愈日系风。风格割裂是字幕审美第一大忌。",
      },
      {
        badge: "原则 03",
        head: "克制极简",
        body: "一行字幕的核心视觉元素绝不超过 2 个（例如：四角渐变 + 轻柔镜头动效）。去掉一切不服务叙事的冗余装饰，越克制越显高级。",
      },
      {
        badge: "原则 04",
        head: "可读底线",
        body: "字幕第一使命是传递词意，第二使命才是审美表达。无论多惊艳的配色，只要牺牲了复杂背景下的清晰可读性，就是彻底失败。",
      },
    ],
  },
  {
    id: "motifs",
    title: "五大叙事母题",
    subtitle: "从「我要表达什么」出发，找到契合的母题光谱",
    items: [
      {
        badge: "宏大叙事 · 史诗",
        head: "英雄史诗 / 科幻巨制 / 历史正剧",
        body: "情绪：壮烈 · 宿命 · 宏大 · 对抗 · 荣耀。代表色系：施耐德末日钢铁、诺兰星际宿命、维伦纽瓦沙漠孤旅、黑泽明武士荣光、银翼杀手废土孤城。",
      },
      {
        badge: "悬疑犯罪 · 幽暗",
        head: "犯罪惊悚 / 悬疑复仇 / 都市暗面",
        body: "情绪：压抑 · 冷峻 · 紧张 · 暴力美感 · 人性幽暗。代表色系：诺兰哥谭暗影、芬奇心理解剖、朴赞郁暴力美学、斯科塞斯纽约霓虹。",
      },
      {
        badge: "文艺抒情 · 孤独",
        head: "都市文艺 / 诗电影 / 记忆与错过",
        body: "情绪：孤独 · 暧昧 · 疏离 · 诗意 · 时间的重量。代表色系：王家卫霓虹遗忘、塔可夫斯基诗意流浪、维伦纽瓦降临灰寂。",
      },
      {
        badge: "日常治愈 · 温情",
        head: "家庭日常 / 青春成长 / 自然奇幻",
        body: "情绪：温柔 · 细腻 · 治愈 · 自由 · 生活的诗意。代表色系：是枝裕和日常温柔、宫崎骏天空之城、新海诚黄昏渐变。",
      },
      {
        badge: "哲思科幻 · 存在",
        head: "硬核科幻 / 人性实验 / 存在主义",
        body: "情绪：冷峻 · 荒诞 · 孤绝 · 人与未知的边界。代表色系：库布里克冷峻凝视（骨白×HAL红，绝对静止即是风格）。",
      },
    ],
  },
  {
    id: "directors",
    title: "十四位导演哲学",
    subtitle: "每位电影大师的调色母题、动效呼吸与绝对禁忌",
    directors: [
      ["施耐德", "snyder_steel", "钢青×烧橙两极对冲，只留光影断层线，慢推入画。", "禁：日常 / 治愈 / 柔光"],
      ["诺兰 (星际)", "nolan_interstellar", "暖铜坠入深空宇宙蓝，纵向 IMAX 宿命感，极缓溶解。", "禁：快切 / 闪烁冲击"],
      ["诺兰 (哥谭)", "nolan_gotham", "冷钢蓝×哥谭深暗，抽干暖色的秩序假象，仪式淡出。", "禁：治愈 / 呼吸位移"],
      ["芬奇", "fincher_anatomy", "毒绿黄×极暗底，数字噪点病变美学；无动效、无淡入。", "禁：柔光 / 任何动效"],
      ["王家卫", "wkw_neon", "琥珀金×深绯红过曝叠影，大散焦残影呼吸。", "禁：低模糊 / 史诗快切"],
      ["库布里克", "kubrick_gaze", "骨白×HAL 红双极对角，对称理性通透凝视。", "禁：一切动效"],
      ["塔可夫斯基", "tarkovsky_poem", "棕褐金×苔藓绿，拜占庭湿版散焦与呼吸光晕。", "禁：冲击 / 闪烁快剪"],
      ["斯科塞斯", "scorsese_neon", "霓虹红×出租车黄，湿沥青街头反光配霓虹微闪。", "禁：自然清新 / 治愈"],
      ["朴赞郁", "park_vengeance", "歌剧深红×冷钢蓝，锐利张力与无淡入冲击闪入。", "禁：柔光 / 淡入 / 日常"],
      ["是枝裕和", "koreeda_gentle", "晨光奶白×旧褐减法美学，自然散焦温度，生活不表演。", "禁：一切动效 / 高饱和"],
      ["宫崎骏", "miyazaki_laputa", "水彩天蓝×向日葵金，手绘透明天空，光在轻轻呼吸。", "禁：暗黑 / 冲击闪烁"],
      ["新海诚", "shinkai_twilight", "暮色紫×晚霞橙，定格黄昏最后一束光与微距对焦。", "禁：犯罪 / 暴力快剪"],
      ["黑泽明", "kurosawa_samurai", "烧金×墨黑，荣耀与必死宿命对峙，静止即是千军万马。", "禁：一切动效 / 娱乐"],
      ["维伦纽瓦", "villeneuve_dune", "沙丘沙金×靛蓝、降临消色青灰，以克制低饱和写孤独宏大。", "禁：高饱和 / 快节奏"],
    ],
  },
  {
    id: "redlines",
    title: "六条红线与进阶",
    subtitle: "守住审美底线，从复刻标杆走向个人表达",
    redlines: [
      "字幕永远是画面的配角，绝不能喧宾夺主抢了人物与构图的戏。",
      "单句核心视觉元素绝不超过 2 个，堆砌特效必然滑向廉价感。",
      "绝不脱离叙事选颜色，不用与剧情情绪相悖的网红滤镜配色。",
      "同一部作品保持统一美学体系，插曲与对白在克制中呼应而非割裂。",
      "绝不牺牲可读性——任何背景下看不清字的设计都应立即回调描边与亮度。",
      "副字幕（英文）亮度宜略低于主字幕（自动降亮 20%），主次分明更耐看。",
    ],
    ladder: [
      ["入门 · 抓形", "借助「创作引导」对标大师预设，准确还原经典电影与 MV 的色调与呼吸节奏。"],
      ["进阶 · 抓神", "在「精细调节」中根据全片剪辑快慢微调淡入淡出、柔边与 HDR 压暗，让参数服务镜头。"],
      ["高阶 · 创格", "将调校成熟的专属配色存为模板，形成一眼可辨的个人双语字幕美学签名。"],
    ],
  },
];
