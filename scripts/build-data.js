// 서울 열린데이터광장 시간표 → data/last-{요일}.json (역 × 역 막차 표)
// 실행: npm run data  (.env에 SEOUL_API_KEY 필요)
// 받은 응답은 data/raw/에 저장해 두므로, 중간에 끊겨도 다시 실행하면 이어서 받음
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { NO_TRAIN, TRANSFER_MIN, WALK_HOME, WEEKS, buildConnections, latestDepartures, stationName } from '../lib.js'

const KEY = process.env.SEOUL_API_KEY
if (!KEY) throw new Error('.env에 SEOUL_API_KEY가 없습니다')

const RAW = new URL('../data/raw/', import.meta.url)
mkdirSync(RAW, { recursive: true })

/** 한 서비스의 모든 행 (1000건씩 끊어 받음). 데이터 없음은 빈 배열 */
async function fetchRows(service, ...params) {
  const rows = []
  for (let start = 1; ; start += 1000) {
    const url = `http://openapi.seoul.go.kr:8088/${KEY}/json/${service}/${start}/${start + 999}/${params.join('/')}`
    let text = ''
    // 서버가 가끔 ERROR-500(일시 오류)을 줌: 잠깐 쉬고 세 번까지 다시 시도
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 3000 * attempt))
      text = await fetch(url).then((r) => r.text()).catch((e) => `ERROR-500 ${e}`)
      if (!text.includes('ERROR-500')) break
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${service} ${params.join('/')}: ${text.slice(0, 200)}`) // 인증키 오류 등은 XML로 옴
    }
    if (body.RESULT?.CODE === 'INFO-200') return rows // 해당하는 데이터 없음
    const result = body[service]
    if (!result) throw new Error(`${service} ${params.join('/')}: ${text.slice(0, 200)}`)
    rows.push(...result.row)
    if (rows.length >= result.list_total_count) return rows
  }
}

/** 역 하나의 한 방향 시간표. 필요한 칸만 남겨 캐시 */
async function timetable(code, week, inout) {
  const file = new URL(`${code}-${week}-${inout}.json`, RAW)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const rows = (await fetchRows('SearchSTNTimeTableByIDService', code, week, inout)).map(
    ({ STATION_CD, LINE_NUM, TRAIN_NO, ARRIVETIME, LEFTTIME }) => ({
      STATION_CD,
      LINE_NUM,
      TRAIN_NO,
      ARRIVETIME,
      LEFTTIME,
    }),
  )
  writeFileSync(file, JSON.stringify(rows))
  await new Promise((r) => setTimeout(r, 100)) // 공공 API에 몰아서 요청하지 않음
  return rows
}

// 시간표 API가 주는 1~9호선만. 그 밖의 노선은 응답이 비어 있음
const stations = (await fetchRows('SearchSTNBySubwayLineInfo')).filter((s) =>
  /^0[1-9]호선$/.test(s.LINE_NUM),
)

for (const [week, label] of Object.entries(WEEKS)) {
  console.log(`${label}: 역 ${stations.length}개 시간표 수집`)
  const rows = []
  for (const [i, station] of stations.entries()) {
    for (const inout of ['1', '2']) rows.push(...(await timetable(station.STATION_CD, week, inout)))
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${stations.length}`)
  }

  const connections = buildConnections(rows)
  if (!connections.length) throw new Error(`${label} 시간표가 비어 있습니다`)

  // 열차가 실제로 서는 승강장만 남기고, 같은 이름끼리 한 역으로 묶음 (환승)
  const served = new Set(connections.flatMap((c) => [c.from, c.to]))
  const byName = new Map()
  for (const s of stations) {
    if (!served.has(s.STATION_CD)) continue
    const name = stationName(s.STATION_NM)
    if (!byName.has(name)) byName.set(name, { name, lines: new Set(), nodes: [] })
    byName.get(name).lines.add(String(Number(s.LINE_NUM.slice(0, 2))))
    byName.get(name).nodes.push(s.STATION_CD)
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  const siblings = new Map(
    list.flatMap((s) => s.nodes.map((node) => [node, s.nodes.filter((other) => other !== node)])),
  )

  // last[집][장소] = 장소 역에서 늦어도 타야 하는 시각(분)
  const last = list.map((home) => {
    const latest = latestDepartures(connections, siblings, home.nodes)
    return list.map((place) => {
      if (place === home) return WALK_HOME
      const best = Math.max(...place.nodes.map((node) => latest.get(node) ?? -Infinity))
      return Number.isFinite(best) ? Math.floor(best) : NO_TRAIN
    })
  })

  writeFileSync(
    new URL(`../data/last-${week}.json`, import.meta.url),
    JSON.stringify({
      generated: new Date().toISOString().slice(0, 10),
      source: `서울 열린데이터광장 지하철 시간표, ${label} 기준`,
      transfer: TRANSFER_MIN,
      stations: list.map((s) => ({ name: s.name, lines: [...s.lines].sort() })),
      last,
    }),
  )
  console.log(`  완료: 역 ${list.length}개, 구간 ${connections.length}개 → data/last-${week}.json`)
}
