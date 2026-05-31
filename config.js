/**
 * 雲町屋 & 多品牌房源日历配置文件 (Config.js)
 * 
 * 此文件采用双重导出模式，既能被浏览器直接通过 <script> 引入，
 * 也能被 Node.js 脚本 (fetch_calendars.js) 通过 require 载入。
 */

const BRANDS_CONFIG = [
  {
    id: "yunmachiya",
    name: "雲町屋",
    icon: "🌸",
    properties: [
      { id: "kyoto_ekimae", name: "雲町屋　京都駅前", ical: "https://www.airbnb.com/calendar/ical/1159852388649700024.ics?t=ded0ed7f6ba641b8b06a3e75c71c647c" },
      { id: "xiaoyu", name: "雲町屋 小御", ical: "https://www.airbnb.com/calendar/ical/32390635.ics?t=8f6f4744d5ae48999f0686636a50491e" },
      { id: "xiaole", name: "雲町屋 小樂", ical: "https://www.airbnb.com/calendar/ical/30211336.ics?t=4a8918abd86247b697c5d38127005f7e" },
      { id: "xiaotao", name: "雲町屋 小蛸", ical: "https://www.airbnb.com/calendar/ical/30075745.ics?t=5a35901149514615a7cb6a1d00d4b1e5" },
      { id: "shuiyingge", name: "雲町屋 水影阁", ical: "https://www.airbnb.com/calendar/ical/25818091.ics?t=8a940fb5cd2642dd9bcae6e3eb4250b7" },
      { id: "fengzao", name: "雲町屋 风早", ical: "https://www.airbnb.com/calendar/ical/21927596.ics?t=11bba9dc20904910b904a2b510120505" },
      { id: "xiaotian", name: "雲町屋 小天", ical: "https://www.airbnb.com/calendar/ical/21829201.ics?t=55d46fc7c218490c92739f38f4c01cb2" },
      { id: "xiaogong", name: "雲町屋 小宫", ical: "https://www.airbnb.com/calendar/ical/19709571.ics?t=7b1751df4e8e41f5b3f67d8db51ac4bb" },
      { id: "xiaoshan", name: "雲町屋 小杉", ical: "https://www.airbnb.com/calendar/ical/18296599.ics?t=56ae3101bbd14254a192f6d5aaf84123" },
      { id: "xiaochi", name: "雲町屋 小池", ical: "https://www.airbnb.com/calendar/ical/46865615.ics?t=e3a8d3bab2954ef9ac289c2108f0bf39" },
      { id: "xiaochuan", name: "雲町屋 小川", ical: "https://www.airbnb.com/calendar/ical/13387993.ics?t=3ba5dddc2ff149e99dda72af519b2b17" },
      { id: "xiaoxing", name: "雲町屋 小星", ical: "https://www.airbnb.com/calendar/ical/11127012.ics?t=10456c68d74840a2ae7ee4d79de86112" },
      { id: "xiaoyue", name: "雲町屋 小月", ical: "https://www.airbnb.com/calendar/ical/15438182.ics?t=ae78d36c8daa46358eb9069bec9b100a" },
      { id: "xiaozhou", name: "雲町屋 小舟", ical: "https://www.airbnb.com/calendar/ical/46866383.ics?t=8c6124b4823d4fecb7f7d082c6da0e45" }
    ]
  },
  {
    id: "qingyouyu",
    name: "庆有鱼",
    icon: "🐟",
    properties: [
      { id: "qing_dummy1", name: "庆有鱼 鸭川观景店", ical: "https://www.airbnb.com/calendar/ical/32390635.ics?t=8f6f4744d5ae48999f0686636a50491e" }, // 暂借用小御的链接作为测试
      { id: "qing_dummy2", name: "庆有鱼 岚山温泉店", ical: "https://www.airbnb.com/calendar/ical/30211336.ics?t=4a8918abd86247b697c5d38127005f7e" }  // 暂借用小乐的链接作为测试
    ]
  }
];

// 如果在 Node.js 环境下，导出配置对象
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BRANDS_CONFIG };
}
