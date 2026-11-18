import { NO_TRAIN, WALK_HOME, WEEKS, hhmm, rank, weekOf } from './lib.js'

// 후보 장소 기본값: 모임이 자주 잡히는 역. 시간표에 있는 역만 쓰임
const HUBS = [
  '강남', '홍대입구', '건대입구', '잠실', '신촌', '종로3가', '사당', '왕십리', '합정', '성수',
  '을지로입구', '이태원', '혜화', '신림', '노원', '고속터미널', '서울역', '동대문역사문화공원',
  '천호', '연신내', '수유', '교대', '신도림', '여의도', '광화문', '공덕', '압구정', '신사',
]
const SHOWN = 10 // shortcut: 상위 10곳만 표시, 전체 보기가 필요해지면 더 보기 버튼 추가

const $ = (id) => document.getElementById(id)
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

// 상태는 주소에 담음: 링크를 단톡방에 올리면 같은 결과가 열림
const query = new URLSearchParams(location.search)
const state = {
  people: (query.get('p') ?? '~,~').split(',').map((pair) => {
    const [name = '', home = ''] = pair.split('~')
    return { name, home }
  }),
  extra: (query.get('c') ?? '').split(',').filter(Boolean),
  walk: Number(query.get('w')) || 10,
  date: query.get('d') || new Date().toLocaleDateString('sv-SE'),
  holiday: query.get('h') === '1',
  pick: query.get('s') ?? '', // 큰 표로 보고 있는 장소. 비어 있으면 가장 늦게까지 있을 수 있는 곳
}
$('walk').value = String(state.walk)
$('date').value = state.date
$('holiday').checked = state.holiday

// 모임 날짜의 요일에 맞는 막차 표를 불러옴 (평일 / 토요일 / 일요일·공휴일)
let data = null
let lines = new Map()
let week = ''
/** 반환값이 false면 기다리는 사이 날짜가 또 바뀐 것: 이 응답은 버리고 화면도 그리지 않음 */
async function load() {
  const next = weekOf(state.date, state.holiday)
  if (next === week) return true
  week = next
  const loaded = await fetch(`data/last-${next}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (week !== next) return false // 늦게 도착한 다른 요일 표가 현재 표를 덮어쓰면 틀린 막차 시각이 나옴
  data = loaded
  lines = new Map((data?.stations ?? []).map((s) => [s.name, s.lines]))
  $('notice').hidden = Boolean(data)
  $('notice').textContent = `${WEEKS[week]} 시간표 데이터를 불러오지 못했습니다.`
  $('source').textContent = data
    ? `${data.source} · ${data.generated} 수집 · 환승 ${data.transfer}분 가정 · 역에서 집까지는 계산하지 않습니다.`
    : ''
  $('stations').replaceChildren(...(data?.stations ?? []).map((s) => el('option', { value: s.name })))
  return true
}

function save() {
  const q = new URLSearchParams({
    p: state.people.map((p) => `${p.name}~${p.home}`).join(','),
    w: String(state.walk),
    d: state.date,
  })
  if (state.holiday) q.set('h', '1')
  if (state.extra.length) q.set('c', state.extra.join(','))
  if (state.pick) q.set('s', state.pick)
  history.replaceState(null, '', `?${q}`)
}

/** "강남역"처럼 적어도 "강남"으로 받음. 단 "서울역"처럼 역명 자체가 '역'으로 끝나면 그대로 둠 */
function stationInput(text) {
  const name = text.trim()
  return lines.has(name) ? name : name.replace(/역$/, '')
}

function renderPeople() {
  $('people').replaceChildren(
    ...state.people.map((person, i) => {
      const unknown = Boolean(data && person.home && !lines.has(person.home))
      const name = el('input', {
        value: person.name,
        placeholder: '이름',
        autocomplete: 'off',
        ariaLabel: `승객 ${i + 1} 이름`,
        oninput: (e) => {
          person.name = e.target.value.replace(/[~,]/g, '')
          renderResults()
        },
      })
      const home = el('input', {
        value: person.home,
        placeholder: '집 근처 역',
        autocomplete: 'off',
        ariaLabel: `승객 ${i + 1} 집 근처 역`,
        ariaInvalid: String(unknown),
        onchange: (e) => {
          person.home = stationInput(e.target.value)
          renderPeople()
          renderResults()
        },
      })
      home.setAttribute('list', 'stations')
      const remove = el('button', {
        type: 'button',
        className: 'remove',
        textContent: '×',
        ariaLabel: `승객 ${i + 1} 삭제`,
        disabled: state.people.length <= 2,
        onclick: () => {
          state.people.splice(i, 1)
          renderPeople()
          renderResults()
        },
      })
      const row = el('li', {}, name, home, remove)
      if (unknown) row.append(el('p', { className: 'error', textContent: '목록에 없는 역입니다. 1~9호선 역만 됩니다.' }))
      return row
    }),
  )
}

const timeText = (min) => (min === WALK_HOME ? '걸어서' : min === NO_TRAIN ? '막차 없음' : hhmm(min))

/** 그 역의 노선색 띠 */
const band = (place) =>
  el(
    'span',
    { className: 'band', ariaHidden: 'true' },
    ...(lines.get(place) ?? []).map((n) => {
      const stripe = el('i')
      stripe.style.background = `var(--line-${n})`
      return stripe
    }),
  )

/** 일찍 일어나야 하는 사람부터 */
const byLeave = (result) => [...result.leaves].sort((a, b) => a.leave - b.leave)

/** 해산 시각에 울리는 캘린더 일정(.ics). 자정을 넘기면 다음 날짜 */
function downloadIcs(result) {
  const start = new Date(`${state.date}T00:00:00`)
  start.setMinutes(result.end)
  const stamp = (d) =>
    `${d.toLocaleDateString('sv-SE').replaceAll('-', '')}T${d.toTimeString().slice(0, 8).replaceAll(':', '')}`
  const end = new Date(start.getTime() + 5 * 60000)
  const who = result.leaves.map((l) => `${l.name || l.home} ${timeText(l.board)} 승차`).join(', ')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//makcha-moim//KO',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@makcha-moim`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:막차 해산 (${result.place})`,
    `DESCRIPTION:${who}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    'DESCRIPTION:10분 뒤 막차 해산',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const link = el('a', {
    href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })),
    download: `막차-${result.place}.ics`,
  })
  link.click()
  URL.revokeObjectURL(link.href)
}

const emptyTicket = (title, body) =>
  el(
    'article',
    { className: 'ticket empty' },
    el('span', { className: 'band' }),
    el('div', { className: 'main' }, el('strong', { textContent: title }), body),
    el('div', { className: 'stub', ariaHidden: 'true', textContent: '--:--' }),
  )

let printed = '' // 큰 표가 바뀔 때만 등장 동작을 줌 (이름을 타이핑할 때마다 깜빡이지 않게)
function bigTicket(result, best) {
  const leaves = byLeave(result)
  const earliest = leaves.find((l) => l.leave !== WALK_HOME)?.leave
  const isTop = result === best
  const key = `${result.place}|${result.end}`
  const ticket = el(
    'article',
    { className: `ticket big${key === printed ? '' : ' fresh'}` },
    band(result.place),
    el(
      'div',
      { className: 'main' },
      el('span', { className: 'lbl', textContent: '모이는 곳' }),
      el('div', { className: 'place', textContent: result.place }),
      el('span', { className: 'lbl', textContent: '해산' }),
      result.end === WALK_HOME
        ? el('div', { className: 'time words', textContent: '시간 제한 없음' })
        : el('div', { className: 'time', textContent: hhmm(result.end) }),
      el(
        'dl',
        {},
        ...leaves.map((l) =>
          el(
            'div',
            {},
            el('dt', { textContent: l.name || l.home }),
            el('dd', { className: l.leave === earliest ? 'first' : '', textContent: timeText(l.leave) }),
          ),
        ),
      ),
      ...(result.end === WALK_HOME
        ? []
        : [
            el('button', {
              type: 'button',
              className: 'text',
              textContent: '캘린더에 해산 알림 넣기',
              onclick: () => downloadIcs(result),
            }),
          ]),
    ),
    el(
      'div',
      { className: 'stub' },
      isTop
        ? el('span', { className: 'top', textContent: '가장 늦게까지' })
        : el('span', { textContent: `가장 늦은 곳보다 ${best.end - result.end}분 일찍` }),
    ),
  )
  printed = key
  return ticket
}

function rowTicket(result) {
  const none = result.end === NO_TRAIN
  const leaves = byLeave(result)
  const same = leaves.every((l) => l.leave === leaves[0].leave)
  const who = none
    ? `${leaves.filter((l) => l.leave === NO_TRAIN).map((l) => l.name || l.home).join(', ')} 귀가 불가`
    : same
      ? `모두 ${timeText(leaves[0].leave)}`
      : leaves.map((l) => `${l.name || l.home} ${timeText(l.leave)}`).join(' · ')
  const inner = [
    band(result.place),
    el('span', { className: 'main' }, el('span', { className: 'place', textContent: result.place }), el('small', { textContent: who })),
    el('span', { className: 'stub', textContent: none ? '막차 없음' : timeText(result.end) }),
  ]
  // 막차가 없는 곳은 고를 수 없으니 버튼이 아님
  return el(
    'li',
    {},
    none
      ? el('div', { className: 'ticket row none' }, ...inner)
      : el(
          'button',
          {
            type: 'button',
            className: 'ticket row',
            ariaLabel: `${result.place}, 해산 ${timeText(result.end)}. 이 곳으로 보기`,
            onclick: () => {
              state.pick = result.place
              renderResults()
              scrollTo({ top: 0, behavior: 'smooth' })
            },
          },
          ...inner,
        ),
  )
}

function renderResults() {
  save()
  const date = new Date(`${state.date}T00:00:00`)
  $('date-label').textContent =
    `${state.date.replaceAll('-', '.')} ${'일월화수목금토'[date.getDay()]}` + (week === '1' ? '' : ` · ${WEEKS[week]} 시간표`)

  const people = state.people.filter((p) => lines.has(p.home))
  const results = data && people.length >= 2 ? rank(data, people, [...new Set([...state.extra, ...HUBS])], state.walk).slice(0, SHOWN) : []
  const usable = results.filter((r) => r.end !== NO_TRAIN)
  const best = usable[0]
  $('others-title').hidden = !best
  $('copy').hidden = !best

  if (!best) {
    printed = ''
    $('others').replaceChildren()
    return $('ticket').replaceChildren(
      results.length
        ? emptyTicket('끊을 수 있는 표가 없습니다', '전원이 막차로 귀가할 수 있는 장소가 없습니다. 날짜나 승객을 바꿔 보세요.')
        : emptyTicket('아직 표가 없습니다', '아래에 승객 두 명 이상의 집 근처 역을 적으면, 모두가 막차로 귀가할 수 있는 해산 시각을 표로 끊어 드립니다.'),
    )
  }

  const picked = usable.find((r) => r.place === state.pick) ?? best
  $('ticket').replaceChildren(bigTicket(picked, best))
  $('others').replaceChildren(...results.filter((r) => r !== picked).map(rowTicket))
}

// 날짜나 공휴일 표시가 바뀌면 시간표가 달라질 수 있음
async function reload() {
  if (!(await load())) return
  renderPeople()
  renderResults()
}

$('add-person').onclick = () => {
  state.people.push({ name: '', home: '' })
  renderPeople()
  $('people').lastElementChild.querySelector('input').focus()
}
$('walk').onchange = (e) => {
  state.walk = Number(e.target.value)
  renderResults()
}
$('date').onchange = (e) => {
  state.date = e.target.value || state.date
  reload()
}
$('holiday').onchange = (e) => {
  state.holiday = e.target.checked
  reload()
}
$('extra').onchange = (e) => {
  const place = stationInput(e.target.value)
  if (lines.has(place) && !state.extra.includes(place)) state.extra.unshift(place)
  e.target.value = ''
  renderResults()
}
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href)
  $('copy').textContent = '링크를 복사했습니다'
  setTimeout(() => ($('copy').textContent = '표 보내기'), 1500)
}

reload()
