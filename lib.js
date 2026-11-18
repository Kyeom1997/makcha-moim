// 막차 계산. 브라우저(app.js)와 Node(scripts/build-data.js, 테스트)가 같이 씀

export const WALK_HOME = 9999 // 모임 장소가 곧 집 근처 역: 열차를 탈 필요 없음
export const NO_TRAIN = -1 // 그 역에서 집까지 가는 열차가 없음

/** 서울시 시간표 API의 요일 구분(WEEK_TAG) */
export const WEEKS = { 1: '평일', 2: '토요일', 3: '일요일·공휴일' }

/** 모임 날짜 → 그날 밤에 쓰는 시간표. 자정 넘은 열차도 모임 당일 시간표에 속함 */
// shortcut: 공휴일을 자동으로 알아내지 못함 (사용자가 직접 표시), 공휴일 달력을 붙이면 자동화
export function weekOf(date, holiday = false) {
  const day = new Date(`${date}T00:00:00`).getDay()
  return holiday || day === 0 ? '3' : day === 6 ? '2' : '1'
}

// shortcut: 환승 시간을 모든 역에서 5분으로 가정, 역별 실제 환승 소요시간 데이터를 구하면 교체
export const TRANSFER_MIN = 5

/** "24:46:30" → 1486.5 (자정부터 분). 자정 넘은 열차는 24시 이후로 이어서 셈. 비어 있으면 null */
export function toMin(hms) {
  if (!hms || hms === '00:00:00') return null // API는 시각이 없는 칸을 00:00:00으로 채움
  const [h, m, s] = hms.split(':').map(Number)
  return (h < 4 ? h + 24 : h) * 60 + m + s / 60
}

/** 1486.5 → "00:46" */
export function hhmm(min) {
  const t = Math.floor(min)
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** 역명 정리: 괄호 부기 제거, 노선마다 이름이 다른 환승역 통일 */
export function stationName(raw) {
  const name = raw.replace(/\(.*\)/, '').trim()
  return { 총신대입구: '이수' }[name] ?? name
}

/**
 * 역별 시간표 행들을 열차 단위로 묶어 "한 역 → 다음 역" 구간 목록으로 바꿈
 * rows: 서울시 SearchSTNTimeTableByIDService 응답 행 (STATION_CD, LINE_NUM, TRAIN_NO, ARRIVETIME, LEFTTIME)
 * 반환: [{ from, to, dep, arr }] 출발 시각이 늦은 순
 */
export function buildConnections(rows) {
  const trips = new Map()
  for (const row of rows) {
    const arr = toMin(row.ARRIVETIME)
    const dep = toMin(row.LEFTTIME)
    if (arr === null && dep === null) continue
    const key = `${row.LINE_NUM}|${row.TRAIN_NO}`
    if (!trips.has(key)) trips.set(key, [])
    trips.get(key).push({ node: row.STATION_CD, arr: arr ?? dep, dep: dep ?? arr })
  }
  const connections = []
  for (const stops of trips.values()) {
    stops.sort((a, b) => a.dep - b.dep)
    for (let i = 0; i + 1 < stops.length; i++) {
      const from = stops[i]
      const to = stops[i + 1]
      if (to.arr >= from.dep) connections.push({ from: from.node, to: to.node, dep: from.dep, arr: to.arr })
    }
  }
  return connections.sort((a, b) => b.dep - a.dep)
}

/**
 * 각 승강장(node)에서 "늦어도 몇 시에 타야 집에 닿는가"
 * connections: buildConnections 결과 (출발이 늦은 순이어야 함)
 * siblings: node → 같은 역의 다른 노선 node 목록 (환승)
 * homeNodes: 집 근처 역의 node들
 * 반환: Map node → 가장 늦은 승차 시각(분). 없는 node는 막차 없음
 */
export function latestDepartures(connections, siblings, homeNodes, transfer = TRANSFER_MIN) {
  const latest = new Map(homeNodes.map((node) => [node, Infinity]))
  // 늦은 열차부터 거꾸로 훑음: 도착역에서 아직 집에 갈 수 있는 열차만 "탈 수 있는 열차"가 됨
  for (const c of connections) {
    if (c.arr > (latest.get(c.to) ?? -Infinity)) continue
    if (c.dep <= (latest.get(c.from) ?? -Infinity)) continue
    latest.set(c.from, c.dep)
    for (const other of siblings.get(c.from) ?? []) {
      if (c.dep - transfer > (latest.get(other) ?? -Infinity)) latest.set(other, c.dep - transfer)
    }
  }
  return latest
}

/**
 * 후보 장소를 "전원이 막차로 귀가할 수 있는 해산 시각"이 늦은 순으로 정렬
 * data: { stations: [{ name }], last: number[][] } — last[집][장소] = 그 장소 역에서 타야 하는 마지막 시각(분)
 * people: [{ name, home }], candidates: 역명 목록, walk: 장소에서 역까지 걷는 시간(분)
 */
export function rank(data, people, candidates, walk = 10) {
  const index = new Map(data.stations.map((s, i) => [s.name, i]))
  return candidates
    .filter((place) => index.has(place))
    .map((place) => {
      const leaves = people.map((person) => {
        const board = data.last[index.get(person.home)][index.get(place)]
        return { ...person, board, leave: board === NO_TRAIN || board === WALK_HOME ? board : board - walk }
      })
      const riders = leaves.filter((l) => l.leave !== WALK_HOME)
      // 한 명이라도 막차가 없으면 그 장소는 해산 시각을 낼 수 없음
      const end = riders.some((l) => l.leave === NO_TRAIN)
        ? NO_TRAIN
        : riders.length
          ? Math.min(...riders.map((l) => l.leave))
          : WALK_HOME
      return { place, end, leaves }
    })
    .sort((a, b) => b.end - a.end)
}
