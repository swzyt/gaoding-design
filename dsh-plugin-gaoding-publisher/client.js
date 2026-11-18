/**
 * 稿定投稿控制台：左侧导航入口（sidebar.panellist）+ 主区域页面（main）。
 * 客户端 bundle 采用 DSH 的 ModuleLoader 协议（无需构建）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-gaoding-publisher',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const name = 'dsh-plugin-gaoding-publisher-client'
    const panelId = 'gaoding-publisher'
    const inject = ['slots']

    const base = () => new URL('gaoding-publisher/', document.baseURI)
    async function request(path, options) {
      const url = new URL(path, base())
      const response = await fetch(url.pathname + url.search, { cache: 'no-store', ...options })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw Error(value.error || '接口请求失败')
      return value
    }
    const api = {
      topics: refresh => request('topics' + (refresh ? '?refresh=1' : '')),
      specs: () => request('specs'),
      spec: key => request('specs?key=' + encodeURIComponent(key)),
      session: () => request('session'),
      probe: () => request('session/probe', { method: 'POST' }),
      login: () => request('session/login', { method: 'POST' }),
      refreshSpecs: (force, key) => request('specs/refresh?' + [force ? 'force=1' : '', key ? 'key=' + encodeURIComponent(key) : ''].filter(Boolean).join('&'), { method: 'POST' }),
      jobs: () => request('jobs'),
      createJobs: payload => request('jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      savePrompt: payload => request('prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      confirmPrompts: jobId => request('prompts/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId }) }),
      generatePrompts: (jobId, force) => request('prompts/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, force: force === true }) }),
      pipelineRun: jobId => request('pipeline/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId }) }),
      publishBatch: taskIds => request('publish/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskIds, submit: true }) }),
      publishCancel: taskId => request('publish/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) }),
      preflight: refresh => request('preflight' + (refresh ? '?refresh=1' : '')),
      publishQueue: () => request('publish/queue'),
      startQueue: taskIds => request('publish/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskIds, submit: true }) }),
      stopQueue: () => request('publish/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }),
      createStatus: () => request('create/status'),
      createPreview: jobId => request('create/preview?job=' + encodeURIComponent(jobId)),
      createRun: (jobId, model, backend) => request('create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, model, backend, confirm: true }) }),
      published: (options = {}) => {
        const params = new URLSearchParams()
        if (options.refresh === true) params.set('refresh', '1')
        if (options.all === true) params.set('all', '1')
        if (options.page) params.set('page', String(options.page))
        if (options.pageSize) params.set('pageSize', String(options.pageSize))
        const query = params.toString()
        return request('published' + (query ? '?' + query : ''))
      },
      health: () => request('health'),
      removeJob: id => request('jobs/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }),
      results: () => request('results'),
      publishCheck: dir => request('publish/check?dir=' + encodeURIComponent(dir)),
      publish: () => request('publish'),
      createPublish: payload => request('publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      removePublish: id => request('publish/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }),
      runPublish: (taskId, submit) => request('publish/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId, submit }) })
    }
    function previewUrl(path) {
      if (!path) return null
      const url = new URL('preview', base())
      url.searchParams.set('path', path)
      return url.pathname + url.search
    }
    async function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(text); return true }
      if (typeof document !== 'undefined' && document.createElement) {
        const area = document.createElement('textarea')
        area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'
        document.body.appendChild(area); area.select()
        const ok = document.execCommand && document.execCommand('copy')
        document.body.removeChild(area)
        if (ok) return true
      }
      throw Error('当前环境不支持自动复制，请手动选择指令文本')
    }

    const color = {
      line: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.1))',
      primary: 'var(--dsw-alias-state-business-primary, #2f6cf6)',
      muted: 'var(--dsw-alias-label-tertiary, #6b7280)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(47,108,246,0.06))'
    }
    const styles = {
      page: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'var(--dsw-alias-label-primary, inherit)' },
      header: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid ' + color.line, flexWrap: 'wrap' },
      body: { flex: 1, display: 'flex', minHeight: 0 },
      left: { width: 420, borderRight: '1px solid ' + color.line, display: 'flex', flexDirection: 'column', minHeight: 0 },
      right: { flex: 1, overflow: 'auto', padding: '16px 22px', minWidth: 0 },
      tab: active => ({ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, background: active ? color.primary : 'transparent', color: active ? '#fff' : 'inherit' }),
      chip: tone => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid ' + color.line, color: tone === 'warn' ? '#b36b00' : tone === 'ok' ? '#0a7d43' : color.muted, background: tone === 'warn' ? 'rgba(255,170,0,0.12)' : tone === 'ok' ? 'rgba(10,125,67,0.10)' : 'transparent' }),
      button: primary => ({ padding: primary ? '7px 16px' : '6px 12px', borderRadius: 8, border: primary ? 'none' : '1px solid ' + color.line, background: primary ? color.primary : 'transparent', color: primary ? '#fff' : 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: primary ? 600 : 500 }),
      input: { width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid ' + color.line, background: 'transparent', color: 'inherit', fontSize: 13 },
      row: active => ({ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid ' + color.line, background: active ? color.hover : 'transparent' }),
      tag: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'rgba(47,108,246,0.10)', color: color.primary, whiteSpace: 'nowrap' },
      section: { marginTop: 14, paddingTop: 12, borderTop: '1px solid ' + color.line },
      label: { fontSize: 12, fontWeight: 600, color: color.muted, marginBottom: 6 },
      canvas: { display: 'inline-block', fontSize: 12, padding: '3px 9px', borderRadius: 6, background: 'rgba(47,108,246,0.10)', color: color.primary, marginRight: 6, marginBottom: 6 }
    }

    function listOf(values, empty) {
      if (!values || !values.length) return h('p', { style: { fontSize: 12.5, color: color.muted, margin: '4px 0' } }, empty)
      return h('ul', { style: { margin: '4px 0', paddingLeft: 18 } }, values.map((text, index) => h('li', { key: index, style: { fontSize: 13, lineHeight: 1.7 } }, text)))
    }

    function formatTime(value) {
      if (!value) return '未知'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    /** 侧栏图标：画板 + 图像，和「设计」语义一致。 */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true
      },
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
      h('circle', { cx: 8.5, cy: 9.5, r: 1.6 }),
      h('path', { d: 'M21 15.5l-4.5-4.5-4 4-2.5-2.5L4 18.5' }))
    }

    function TopicRow(props) {
      const { topic, spec, failure, active, onClick } = props
      const canvas = spec && spec.canvas && spec.canvas.length ? spec.canvas.join(' / ') : topic.specs || ''
      const status = spec ? '规范已抓取' : failure ? failure.error : topic.rules_url ? '规范待抓取' : '无规范链接'
      return h('div', { style: styles.row(active), onClick },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('span', { style: { fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, topic.name),
            topic.publishKind === 'material' ? h('span', { style: { ...styles.tag, background: 'rgba(10,125,67,0.12)', color: '#0a7d43' } }, '素材') : null,
            topic.type ? h('span', { style: styles.tag }, topic.type) : null
          ),
          h('div', { style: { fontSize: 11.5, color: color.muted, marginTop: 2 } }, [canvas, status].filter(Boolean).join(' · '))
        ),
        h('span', { style: { fontSize: 11, color: spec ? '#0a7d43' : failure ? '#b36b00' : color.muted, paddingTop: 2 } }, spec ? '●' : failure ? '▲' : '○')
      )
    }

    function SpecDetail(props) {
      const { topic, spec, failure, loading, onFetch, busy } = props
      if (!topic) return h('div', { style: { color: color.muted, fontSize: 13.5, paddingTop: 40, textAlign: 'center' } }, '从左侧选择一个话题，这里显示它的创作规范')
      if (loading) return h('p', { style: { fontSize: 13, color: color.muted } }, '正在读取规范…')
      if (!spec) {
        return h('div', null,
          h('h3', { style: { margin: '0 0 6px', fontSize: 17 } }, topic.name),
          h('p', { style: { fontSize: 13, color: color.muted } },
            topic.rules_url ? '这个话题还没有抓取创作规范。' : '这个话题在目录里没有规范链接，需要研究详情页确认。'),
          failure ? h('p', { style: { fontSize: 12.5, color: '#b36b00' } }, '上次抓取失败：' + failure.error) : null,
          topic.rules_url ? h('p', { style: { fontSize: 12, wordBreak: 'break-all' } }, h('a', { href: topic.rules_url, target: '_blank', rel: 'noreferrer', style: { color: color.primary } }, topic.rules_url)) : null,
          h('div', { style: { marginTop: 12 } },
            h('button', { type: 'button', style: styles.button(true), disabled: busy || !topic.rules_url, onClick: onFetch }, busy ? '抓取中…' : '抓取这个话题的规范')
          )
        )
      }
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 18 } }, spec.title || topic.name),
          topic.type ? h('span', { style: styles.tag }, topic.type) : null
        ),
        h('p', { style: { fontSize: 11.5, color: color.muted, margin: '6px 0 0' } },
          '抓取于 ' + formatTime(spec.fetchedAt) + (spec.wordCount ? ' · 正文 ' + spec.wordCount + ' 字' : '') + (spec.updatedAt ? ' · 规范更新 ' + formatTime(spec.updatedAt) : '')
        ),
        spec.canvas && spec.canvas.length ? h('div', { style: styles.section },
          h('div', { style: styles.label }, '画板尺寸'),
          h('div', null, spec.canvas.map(row => h('span', { key: row.label, style: styles.canvas }, row.label + 'px')))
        ) : null,
        spec.forbidden && spec.forbidden.length ? h('div', { style: styles.section },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: '#c0392b', marginBottom: 6 } }, '禁止事项'),
          listOf(spec.forbidden, '无')
        ) : null,
        spec.materials && spec.materials.length ? h('div', { style: styles.section },
          h('div', { style: styles.label }, '关键物料与硬性要求'),
          listOf(spec.materials, '无')
        ) : null,
        spec.directions && spec.directions.length ? h('div', { style: styles.section },
          h('div', { style: styles.label }, '创作方向参考'),
          listOf(spec.directions, '无')
        ) : null,
        h('div', { style: styles.section },
          h('div', { style: styles.label }, '规范原文'),
          h('pre', { style: { fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto', background: 'rgba(0,0,0,0.03)', padding: 10, borderRadius: 8, margin: 0 } }, spec.text || spec.excerpt || '（正文为空）')
        ),
        spec.images && spec.images.length ? h('div', { style: styles.section },
          h('div', { style: styles.label }, '规范配图'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            spec.images.map(src => h('img', { key: src, src, alt: '规范配图', style: { width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid ' + color.line } }))
          )
        ) : null,
        h('div', { style: styles.section },
          h('a', { href: spec.url, target: '_blank', rel: 'noreferrer', style: { color: color.primary, fontSize: 12.5 } }, '打开规范原文 ↗')
        )
      )
    }

    const jobStatusText = { queued: '排队中', starting: '启动中', running: '进行中', waiting_agent: '等待 Agent 处理', attention: '需要处理', complete: '已完成' }
    const unitStageText = {
      queued: '排队中', 'prompt-ready': '待确认 prompt', 'ready-to-create': '待创作',
      'waiting-assets': '等待出图素材', creating: '创作中', created: '已创作·待投稿',
      publishing: '投稿中', published: '已投稿', failed: '创作失败'
    }
    const jobProgressText = {
      'published-all': '全部已投稿', 'published-partial': '部分已投稿', publishing: '投稿中',
      'ready-to-publish': '创作完成·待投稿', 'waiting-assets': '等待出图素材', 'needs-attention': '需要处理',
      queued: '排队中', 'in-progress': '进行中'
    }
    const unitStageOf = unit => unit.progress?.stage ?? unit.status
    const unitLine = unit => {
      const stage = unitStageText[unitStageOf(unit)] || unitStageOf(unit)
      const extra = unit.progress?.contentId ? '（作品 ' + unit.progress.contentId + (unit.progress.declarationStatus ? ' · 声明' + unit.progress.declarationStatus : '') + '）'
        : unit.progress?.failure ? '（' + String(unit.progress.failure.error).slice(0, 40) + '）'
          : unit.assets && unit.assets.requested ? '（素材 ' + unit.assets.ready + '/' + unit.assets.requested + '）' : ''
      return '单元' + unit.index + '：' + stage + extra
    }
    const jobStatusColor = { queued: color.muted, starting: '#b36b00', running: color.primary, waiting_agent: '#b36b00', attention: '#c0392b', complete: '#0a7d43' }

    function CreateTab(props) {
      const { topics, specIndex, failureIndex } = props
      const [selected, setSelected] = React.useState([])
      const [quantity, setQuantity] = React.useState(1)
      const [quantityText, setQuantityText] = React.useState('1')
      const [note, setNote] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [jobs, setJobs] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState('')
      const [drafts, setDrafts] = React.useState({})
      const [openPrompt, setOpenPrompt] = React.useState({})
      const [confirming, setConfirming] = React.useState(null)
      const [backend, setBackend] = React.useState('gd-cli')
      const [mode, setMode] = React.useState('manual')

      const ready = topics.filter(topic => topic.rules_url)
      const byKind = kind === 'template' ? ready.filter(topic => topic.publishKind !== 'material')
        : kind === 'material' ? ready.filter(topic => topic.publishKind === 'material')
          : ready
      const visible = byKind.filter(topic => !query || topic.name.toLowerCase().includes(query.toLowerCase()))
      const active = jobs.filter(job => job.status !== 'complete').length

      async function loadJobs() {
        try { const value = await api.jobs(); setJobs(value.jobs || []) } catch (e) { setError('任务列表加载失败：' + e.message) }
      }
      React.useEffect(() => { loadJobs() }, [])
      React.useEffect(() => {
        if (!jobs.some(job => job.status !== 'complete' || job.generation?.running || job.creation?.running)) return
        const timer = setInterval(loadJobs, 3000)
        return () => clearInterval(timer)
      }, [jobs.map(job => job.status).join(',')])

      function toggle(key) {
        setSelected(prev => prev.includes(key) ? prev.filter(row => row !== key) : prev.concat(key))
        setError('')
      }
      async function create() {
        if (!selected.length) { setError('至少选择一个话题'); return }
        setBusy('create'); setError('')
        try {
          const value = await api.createJobs({ topics: selected, quantity, note, mode, backend })
          setJobs(prev => [...(value.jobs || []), ...prev])
          setSelected([])
        } catch (e) { setError('创建任务失败：' + e.message) }
        finally { setBusy('') }
      }
      async function copy(job) {
        try { await copyText(job.instruction); setCopied(job.id); setTimeout(() => setCopied(''), 1500) }
        catch (e) { setError(e.message) }
      }
      async function savePrompt(unit) {
        setBusy('prompt:' + unit.id); setError('')
        try {
          await api.savePrompt({ unitId: unit.id, prompt: drafts[unit.id] ?? unit.prompt?.prompt ?? '', direction: unit.brief?.direction ?? undefined })
          await loadJobs()
        } catch (e) { setError('保存失败：' + e.message) }
        finally { setBusy('') }
      }
      async function regenerate(job) {
        setBusy('gen:' + job.id); setError('')
        try {
          const result = await api.generatePrompts(job.id, true)
          await loadJobs()
          if (result?.alreadyRunning) setError('')
        } catch (e) {
          // 已经在生成不是失败，保持静默并显示进度。
          if (!/正在生成/.test(e.message)) setError('生成失败：' + e.message)
        } finally { setBusy('') }
      }
      // 全自动链路中断后的人工重试：已完成单元会跳过，只补未完成与未投稿的部分。
      async function retryPipeline(job) {
        setBusy('pipeline:' + job.id); setError('')
        try {
          await api.pipelineRun(job.id)
          await loadJobs()
        } catch (e) { setError('重试失败：' + e.message) }
        finally { setBusy('') }
      }
      async function askCreate(job) {
        setBusy('ask:' + job.id); setError('')
        try {
          const [status, preview] = await Promise.all([api.createStatus(), api.createPreview(job.id)])
          setConfirming({ jobId: job.id, status, preview })
        } catch (e) { setError(e.message) }
        finally { setBusy('') }
      }
      const envBlocked = props.envBlocked === true

      async function runCreate(job) {
        setBusy('run:' + job.id); setError('')
        try {
          const result = await api.createRun(job.id, confirming?.preview?.model, confirming?.backend ?? 'gd-cli')
          if (result?.mode === 'agent') { await copyText(result.instruction); setError('已复制执行指令，交给 Agent 出图') ; setConfirming(null); return }
          setConfirming(null)
          await loadJobs()
        } catch (e) { setError('创作失败：' + e.message) }
        finally { setBusy('') }
      }
      async function confirmJob(job) {
        setBusy('confirm'); setError('')
        try { await api.confirmPrompts(job.id); await loadJobs() }
        catch (e) { setError('确认失败：' + e.message) }
        finally { setBusy('') }
      }
      async function remove(id) {
        try { await api.removeJob(id); await loadJobs() } catch (e) { setError('删除失败：' + e.message) }
      }

      return h('div', { style: styles.body },
        h('div', { style: styles.left },
          h('div', { style: { padding: '10px 14px', borderBottom: '1px solid ' + color.line } },
            h('input', { style: styles.input, type: 'search', placeholder: '搜索话题名称', value: query, onChange: e => setQuery(e.target.value) }),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
              [['', '全部'], ['template', '模板'], ['material', '素材']].map(([value, label]) => h('button', {
                key: value || 'all', type: 'button', onClick: () => setKind(value),
                style: { ...styles.button(kind === value), padding: '4px 10px', fontSize: 12 }
              }, label))
            ),
            h('p', { style: { fontSize: 11.5, color: color.muted, margin: '8px 0 0' } },
              '可选 ' + byKind.length + ' 个有规范的话题 · 已选 ' + selected.length + ' 个')
          ),
          h('div', { style: { flex: 1, overflow: 'auto' } },
            visible.map(topic => h('label', { key: topic.key, style: styles.row(selected.includes(topic.key)) },
              h('input', { type: 'checkbox', checked: selected.includes(topic.key), onChange: () => toggle(topic.key), style: { marginTop: 3 } }),
              h('span', { style: { flex: 1, minWidth: 0 } },
                h('span', { style: { display: 'block', fontSize: 13.5, fontWeight: 600 } },
                  topic.name,
                  topic.publishKind === 'material' ? h('span', { style: { marginLeft: 6, fontSize: 10.5, padding: '1px 6px', borderRadius: 999, background: 'rgba(10,125,67,0.12)', color: '#0a7d43' } }, '素材') : null
                ),
                h('span', { style: { display: 'block', fontSize: 11.5, color: color.muted } },
                  [topic.type, (specIndex.get(topic.key)?.canvas || []).join(' / ') || (failureIndex.get(topic.key) ? '规范受限' : '规范待抓取')].filter(Boolean).join(' · ')
                )
              )
            )),
            !visible.length ? h('p', { style: { padding: 16, fontSize: 13, color: color.muted } }, ready.length ? '没有匹配的话题' : '还没有可用话题，请先在「话题与规范」刷新并抓取规范') : null
          )
        ),
        h('div', { style: styles.right },
          h('h3', { style: { margin: '0 0 10px', fontSize: 17 } }, '新建创作任务'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: styles.label }, '每个话题创作数量'),
            h('input', {
              type: 'number', min: 1, max: 20, step: 1, value: quantityText,
              onChange: e => {
                const raw = e.target.value
                setQuantityText(raw)
                const parsed = Number(raw)
                if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) setQuantity(Math.floor(parsed))
              },
              onBlur: () => {
                const parsed = Number(quantityText)
                const fixed = Number.isFinite(parsed) ? Math.min(20, Math.max(1, Math.floor(parsed))) : 1
                setQuantity(fixed); setQuantityText(String(fixed))
              },
              style: { ...styles.input, width: 90 }
            }),
            h('span', { style: { fontSize: 11.5, color: color.muted } }, '1–20，默认 1')
          ),
          h('p', { style: { fontSize: 12, color: color.muted } }, '数量 2 表示同一话题做 2 份独立稿，各自单独投稿。'),  
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' } },
            h('span', { style: styles.label }, '执行模式'),
            [['manual', '手动确认'], ['auto', '全自动']].map(([value, label]) => h('button', {
              key: value, type: 'button', onClick: () => setMode(value),
              style: { ...styles.button(mode === value), padding: '4px 10px', fontSize: 12 }
            }, label))
          ),
          h('p', { style: { fontSize: 11.5, color: color.muted, marginTop: 4 } },
            mode === 'auto'
              ? '全自动：生成 prompt 后自动确认并开始创作，不再逐步确认。发布仍需一次稿定 SSO 登录。'
              : '手动：每一步（prompt 确认、开始创作）都由你点击推进。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' } },
            h('span', { style: styles.label }, '出图后端（素材话题）'),
            [['gd-cli', '本机 GD CLI'], ['image-gen', 'DSH 出图（0 稿豆）'], ['agent', '交给 Agent']].map(([value, label]) => h('button', {
              key: value, type: 'button', onClick: () => setBackend(value),
              style: { ...styles.button(backend === value), padding: '4px 10px', fontSize: 12 }
            }, label))
          ),
          h('p', { style: { fontSize: 11.5, color: color.muted, marginTop: 4 } }, '模板话题在本地渲染分层 PSD，不消耗稿豆。'),
          h('textarea', {
            style: { ...styles.input, minHeight: 70, marginTop: 10, resize: 'vertical', fontFamily: 'inherit' },
            placeholder: '创作要求（可选）：风格、文案方向、必须出现的元素等',
            value: note, onChange: e => setNote(e.target.value)
          }),
          h('div', { style: { display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' } },
            h('button', { type: 'button', style: styles.button(true), disabled: !!busy || !selected.length, onClick: create },
              busy === 'create' ? '创建中…' : '创建任务（' + selected.length + '）'),
            h('span', { style: { fontSize: 12, color: color.muted } }, active ? active + ' 个任务未完成' : '没有进行中的任务')
          ),
          error ? h('p', { style: { fontSize: 12.5, color: '#c0392b', marginTop: 10 } }, error) : null,
          h('div', { style: styles.section },
            h('div', { style: styles.label }, '任务列表'),
            !jobs.length ? h('p', { style: { fontSize: 12.5, color: color.muted } }, '还没有任务') : null,
            jobs.map(job => {
              const states = (job.units || []).map(unit => unit.promptState || 'missing')
              const allWritten = states.length > 0 && states.every(state => state === 'written' || state === 'confirmed')
              const allConfirmed = states.length > 0 && states.every(state => state === 'confirmed')
              const gen = job.generation
              return h('div', { key: job.id, style: { border: '1px solid ' + color.line, borderRadius: 10, padding: '10px 12px', marginBottom: 8 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, job.topic.name),
                  h('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, color: job.status === 'complete' ? '#0a7d43' : jobStatusColor[job.status] || color.muted, background: 'rgba(0,0,0,0.04)' } },
                  job.progress ? jobProgressText[job.progress.stage] || job.status : jobStatusText[job.status] || job.status),
                  h('span', { style: { fontSize: 11.5, color: color.muted } }, '数量 ' + job.quantity),
                  h('span', { style: styles.tag }, job.mode === 'auto' ? '全自动' : '手动'),
                  h('span', { style: { fontSize: 11, color: job.backend === 'image-gen' ? '#0a7d43' : color.muted } },
                    job.backend === 'image-gen' ? 'DSH 出图（0 稿豆）' : job.backend === 'agent' ? 'Agent 出图' : 'GD CLI'),
                  job.pipeline && job.progress?.stage !== 'published-all' ? h('span', { style: { fontSize: 11, color: job.pipeline.error ? '#c0392b' : job.pipeline.stage === 'waiting-assets' ? '#b36b00' : color.primary } },
                    (job.pipeline.running ? '自动执行中 · '
                      : job.pipeline.stage === 'waiting-assets' ? '等待出图素材 · '
                        : job.pipeline.error ? '自动中断 · ' : '自动完成 · ') + job.pipeline.stage) : null,
                  job.units.some(unit => unit.assets?.state === 'waiting')
                    ? h('span', { style: { fontSize: 11, color: '#b36b00' } },
                      '等待出图素材 ' + job.units.filter(unit => unit.assets?.state === 'ready').length + '/' +
                      job.units.filter(unit => unit.assets).length)
                    : null,
                  h('span', { style: { fontSize: 11, color: allConfirmed ? '#0a7d43' : '#b36b00' } },
                    allConfirmed ? 'prompt 已确认'
                      : gen?.running ? 'AI 生成中 ' + gen.done + '/' + gen.total
                        : allWritten ? 'prompt 待你确认'
                          : gen?.error ? '生成失败' : 'prompt 待生成'),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', style: styles.button(false), disabled: !!busy || gen?.running, onClick: () => regenerate(job) },
                    busy === 'gen:' + job.id ? '生成中…' : allConfirmed ? '重新生成 prompt' : 'AI 生成 prompt'),
                  h('button', { type: 'button', style: styles.button(false), onClick: () => copy(job) },
                    copied === job.id ? '已复制' : allConfirmed ? '复制执行指令' : '复制指令（备用）'),
                  job.mode === 'auto' && job.progress?.stage !== 'published-all' && !job.pipeline?.running
                    ? h('button', { type: 'button', style: styles.button(false), disabled: !!busy, onClick: () => retryPipeline(job) },
                      busy === 'pipeline:' + job.id ? '重试中…' : job.pipeline?.error ? '重试自动投稿' : '继续自动投稿')
                    : null,
                  job.status === 'queued' ? h('button', { type: 'button', style: styles.button(false), onClick: () => remove(job.id) }, '删除') : null
                ),
                job.progress?.stage === 'waiting-assets' ? h('div', { style: { fontSize: 11.5, color: '#b36b00', marginTop: 4 } },
                  '待出图：' + [...new Set((job.pipeline?.waitingAssets || [])
                    .flatMap(row => row.request || [])
                    .concat((job.creation?.failed || []).filter(row => row.code === 'ASSETS_WAITING').flatMap(row => row.request || [])))].join('、') +
                  ' → 出图后点「继续自动投稿」'
                ) : null,
                h('div', { style: { fontSize: 11.5, color: color.muted, marginTop: 4 } },
                  (job.units || []).map(unitLine).join(' · ')
                ),
                (job.units || []).some(unit => unit.brief?.direction) ? h('div', { style: { marginTop: 6, fontSize: 11.5, color: color.muted } },
                  h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '创作要求（按规范生成，单元间方向不同）'),
                  (job.units || []).map(unit => h('div', { key: unit.id },
                    '单元' + unit.index + '：' + (unit.brief?.direction ?? '方向自定')
                      + (unit.brief?.canvas?.length ? ' · ' + unit.brief.canvas.join('/') : '')
                  ))
                ) : null,
                allWritten ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: { fontSize: 11.5, fontWeight: 600, marginBottom: 4 } }, allConfirmed ? '已确认的 prompt（出图将严格按此执行）' : 'prompt 审核：看过或改过再确认，确认后才会出图'),
                  (job.units || []).map(unit => {
                    const expanded = openPrompt[unit.id] === true
                    const text = drafts[unit.id] ?? unit.prompt?.prompt ?? ''
                    return h('div', { key: unit.id, style: { marginBottom: 6, border: '1px solid ' + color.line, borderRadius: 8, padding: '6px 8px' } },
                      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                        h('span', { style: { fontSize: 11, color: color.muted, flex: 1 } }, '单元' + unit.index + ' · ' + (unit.prompt?.direction ?? unit.brief?.direction ?? '')),
                        h('span', { style: { fontSize: 10.5, color: color.muted } }, text.length + ' 字'),
                        h('button', {
                          type: 'button',
                          style: { ...styles.button(false), padding: '1px 8px', fontSize: 11 },
                          onClick: () => setOpenPrompt(prev => ({ ...prev, [unit.id]: !expanded }))
                        }, expanded ? '收起' : '查看 / 编辑')
                      ),
                      expanded
                        ? h('textarea', {
                          style: { ...styles.input, minHeight: 96, maxHeight: 220, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, marginTop: 6, opacity: allConfirmed ? 0.75 : 1 },
                          value: text,
                          readOnly: allConfirmed,
                          onChange: e => setDrafts(prev => ({ ...prev, [unit.id]: e.target.value }))
                        })
                        : h('div', {
                          style: { fontSize: 11.5, color: color.muted, marginTop: 3, lineHeight: 1.5, maxHeight: 34, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }
                        }, text || '还没生成 prompt'),
                      !allConfirmed ? h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                        h('button', { type: 'button', style: styles.button(false), disabled: busy === 'prompt:' + unit.id, onClick: () => savePrompt(unit) }, busy === 'prompt:' + unit.id ? '保存中…' : '保存这一单元的 prompt')
                      ) : null
                    )
                  }),
                  !allConfirmed && job.mode !== 'auto' ? h('button', { type: 'button', style: styles.button(true), disabled: !!busy, onClick: () => confirmJob(job) }, '确认 prompt 并允许出图') : null
                ) : null,
                gen?.error ? h('div', { style: { fontSize: 11.5, color: '#c0392b', marginTop: 4 } }, 'AI 生成失败：' + gen.error + '（可重试，或把备用指令发给对话里的 Agent）') : null,
                job.status === 'queued' && !allWritten && !gen?.running ? h('div', { style: { fontSize: 11.5, color: '#b36b00', marginTop: 4 } }, 'prompt 会自动生成；生成后在这里审核确认，确认之后才会出图。') : null,
                allConfirmed && job.status === 'queued' ? h('div', { style: { marginTop: 8 } },
                  job.creation?.running
                    ? h('div', { style: { fontSize: 12, color: color.primary } }, '正在创作：' + job.creation.done + '/' + job.creation.total)
                    : h('button', { type: 'button', style: styles.button(true), disabled: !!busy, onClick: () => askCreate(job) },
                      busy === 'ask:' + job.id ? '读取中…' : job.kind === 'material' ? '开始创作（生成本单元素材图）' : '开始创作（生成分层模板）'),
                  job.creation?.failed?.some(f => f.code !== 'ASSETS_WAITING')
                    ? h('div', { style: { fontSize: 11.5, color: '#c0392b', marginTop: 4 } },
                      '创作失败：' + [...new Set(job.creation.failed.filter(f => f.code !== 'ASSETS_WAITING').map(f => f.error))].join('；'))
                    : null,
                  confirming?.jobId === job.id ? h('div', { style: { marginTop: 8, border: '1px solid ' + color.line, borderRadius: 8, padding: '10px 12px' } },
                    h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } },
                      confirming.preview?.free ? '模板排版本身不消耗稿豆'
                        : job.backend === 'image-gen' ? '本次不消耗稿豆（DSH 出图）'
                          : '确认生成会消耗稿豆'),
                    h('div', { style: { fontSize: 11.5, color: color.muted } },
                      confirming.preview?.free
                        ? '模型写分层配方，本地渲染成可编辑 PSD；文字保持原生可编辑。素材走选定后端生成。'
                        : job.backend === 'image-gen'
                          ? '素材由 DSH 图像插件生成（订阅额度，不扣稿豆），完成后再本地渲染分层模板。'
                          : '模型 ' + (confirming.preview?.model ?? '') +
                            ' · 单张 ' + (confirming.status?.models?.find(m => m.model === confirming.preview?.model)?.min ?? '?') + '–' + (confirming.status?.models?.find(m => m.model === confirming.preview?.model)?.max ?? '?') + ' 稿豆' +
                            ' · 余额 ' + (confirming.status?.credits ?? '未知') + ' 稿豆'),
                    h('div', { style: { fontSize: 11.5, color: color.muted, marginTop: 2 } },
                      (confirming.preview?.units ?? []).filter(u => u.input).map(u => '单元' + u.index + ' ' + u.input.width + '×' + u.input.height).join(' / ')),
                    confirming.preview?.free ? null : h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
                      [['gd-cli', '本机 GD CLI'], ['image-gen', 'DSH 出图（0 稿豆）'], ['agent', '交给 Agent']].map(([value, label]) => h('button', {
                        key: value, type: 'button', onClick: () => setBackend(value),
                        style: { ...styles.button(backend === value), padding: '4px 10px', fontSize: 12 }
                      }, label))
                    ),
                    !confirming.preview?.free && backend === 'agent' ? h('div', { style: { fontSize: 11, color: color.muted, marginTop: 4 } }, 'DSH 图像插件未安装时会走 Agent；确认后只复制指令，不扣稿豆。') : null,
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                      h('button', { type: 'button', style: styles.button(true), disabled: !!busy || envBlocked, onClick: () => runCreate(job) }, busy === 'run:' + job.id ? '提交中…' : envBlocked ? '依赖缺失，已禁用' : '确认生成'),
                      h('button', { type: 'button', style: styles.button(false), onClick: () => setConfirming(null) }, '取消'))
                  ) : null
                ) : null,
                allConfirmed && job.status === 'queued' ? h('div', { style: { fontSize: 11.5, color: color.muted, marginTop: 4 } }, '也可以复制执行指令交给 Agent 执行。') : null
              )
            })
          )
        )
      )
    }

    // 与 published.js 的 auditState 保持一致的判定（客户端不能 import 服务端模块）。
    function auditState(row) {
      const publishType = Number(row.publishType ?? 0)
      const publishStatus = String(row.publishStatus ?? '').toUpperCase()
      if (publishType === 2 && (row.declarationStatus === 'WAITING_MATERIALS' || publishStatus === 'WAITING_MATERIALS')) {
        return { key: 'declaration', text: '待声明' }
      }
      const cqc = row.cqcStatus ?? null
      if (publishStatus === 'QUALITY_REJECTED' || publishStatus === 'REJECTED' || cqc === 2) return { key: 'rejected', text: '审核不通过' }
      if (cqc === 0 || row.crcStatus === 0) return { key: 'reviewing', text: '审核中' }
      if (cqc === 1) return { key: 'passed', text: '已通过' }
      return { key: 'unknown', text: '未知' }
    }

    // 创作完成 ≠ 投稿完成：结果列表按真实阶段分开显示。
    const stageLabel = {
      creating: '创作中',
      created: '已创作 · 待投稿',
      ready: '已创作 · 待投稿',
      publishing: '投稿中',
      uncertain: '投稿结果待核对',
      published: '已投稿'
    }
    const publishStatusLabel = { queued: '待投稿', submitting: '投稿中', uncertain: '结果不确定（需核对）', published: '已投稿' }
    const publishStatusColor = { queued: color.muted, submitting: color.primary, uncertain: '#c0392b', published: '#0a7d43' }

    function ResultsTab() {
      const [runs, setRuns] = React.useState([])
      const [selected, setSelected] = React.useState(null)
      const [check, setCheck] = React.useState(null)
      const [tasks, setTasks] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState('')
      const [topicQuery, setTopicQuery] = React.useState('')
      const [checked, setChecked] = React.useState([])
      const [queue, setQueue] = React.useState(null)

      function toggleCheck(id) {
        setChecked(prev => prev.includes(id) ? prev.filter(row => row !== id) : prev.concat(id))
      }
      async function cancelBatch() {
        setBusy('cancel'); setError('')
        const failed = []
        for (const id of checked) {
          try { await api.publishCancel(id) } catch (e) { failed.push(String(e.message)) }
        }
        setChecked([])
        await loadTasks()
        if (failed.length) setError('部分任务没能取消：' + failed.join('；'))
        setBusy('')
      }
      async function publishBatch() {
        if (!checked.length) { setError('先勾选要投稿的任务'); return }
        setBusy('batch'); setError('')
        try {
          const result = await api.publishBatch(checked)
          setChecked([])
          await loadTasks()
          if (result?.skipped?.length) setError('已跳过：' + result.skipped.map(row => row.reason).join('、'))
        } catch (e) { setError('批量投稿失败：' + e.message) }
        finally { setBusy('') }
      }

      async function loadQueue() { try { const value = await api.publishQueue(); setQueue(value.queue ?? null) } catch {} }
      async function startQueue() { setBusy('queue'); setError(''); try { await api.startQueue(checked.length ? checked : undefined); setChecked([]); await loadQueue(); await loadTasks() } catch (e) { setError('启动队列失败：' + e.message) } finally { setBusy('') } }
      async function stopQueue() { setBusy('queue'); try { await api.stopQueue(); await loadQueue() } catch (e) { setError('停止失败：' + e.message) } finally { setBusy('') } }
      async function loadRuns() { try { const value = await api.results(); setRuns(value.runs || []) } catch (e) { setError('结果加载失败：' + e.message) } }
      async function loadTasks() { try { const value = await api.publish(); setTasks(value.tasks || []) } catch (e) { setError('投稿任务加载失败：' + e.message) } }
      React.useEffect(() => { loadRuns(); loadTasks(); loadQueue() }, [])
      React.useEffect(() => {
        if (!queue?.running) return
        const timer = setInterval(() => { loadQueue(); loadTasks() }, 5000)
        return () => clearInterval(timer)
      }, [queue?.running])
      React.useEffect(() => {
        if (!tasks.some(task => task.status !== 'published')) return
        const timer = setInterval(loadTasks, 5000)
        return () => clearInterval(timer)
      }, [tasks.map(task => task.status).join(',')])

      async function pick(run) {
        setSelected(run.directory); setCheck(null); setBusy('check'); setError('')
        try { setCheck(await api.publishCheck(run.directory)) } catch (e) { setError('检查失败：' + e.message) }
        finally { setBusy('') }
      }
      async function createPublish() {
        if (!selected) return
        setBusy('create'); setError('')
        try {
          await api.createPublish({ dir: selected })
          await loadTasks()
          setCheck(await api.publishCheck(selected))
        } catch (e) { setError('创建投稿任务失败：' + e.message) }
        finally { setBusy('') }
      }
      async function copy(task) {
        try { await copyText(task.instruction); setCopied(task.id); setTimeout(() => setCopied(''), 1500) }
        catch (e) { setError(e.message) }
      }
      async function runPublishTask(task, submit) {
        setBusy((submit ? 'ps:' : 'pd:') + task.id); setError('')
        try {
          await api.runPublish(task.id, submit)
          for (let i = 0; i < 40; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000))
            const value = await api.publish()
            setTasks(value.tasks || [])
            const current = (value.tasks || []).find(row => row.id === task.id)
            if (current && !current.run?.running) break
          }
        } catch (e) { setError('投稿执行失败：' + e.message) }
        finally { setBusy('') }
      }
      async function removeTask(id) {
        try { await api.removePublish(id); await loadTasks() } catch (e) { setError('删除失败：' + e.message) }
      }

      const current = runs.find(run => run.directory === selected) || null
      const task = selected ? tasks.find(row => row.runDir === selected) : null
      const layers = check?.layers || []
      const passed = check?.ok === true

      return h('div', { style: styles.body },
        h('div', { style: styles.left },
          h('div', { style: { padding: '10px 14px', borderBottom: '1px solid ' + color.line } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '创作结果 ' + runs.length),
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', style: styles.button(false), onClick: loadRuns }, '刷新')
            ),
            h('input', { style: { ...styles.input, marginTop: 8 }, type: 'search', placeholder: '按话题筛选', value: topicQuery, onChange: e => setTopicQuery(e.target.value) })
          ),
          h('div', { style: { flex: 1, overflow: 'auto' } },
            !runs.length ? h('p', { style: { padding: 16, fontSize: 13, color: color.muted } }, '还没有创作结果。创建任务并由 Agent 执行后会出现在这里。') : null,
            runs.filter(run => !topicQuery || String(run.topic ?? run.name ?? '').toLowerCase().includes(topicQuery.toLowerCase())).map(run => h('div', {
              key: run.directory, style: styles.row(run.directory === selected), onClick: () => pick(run)
            },
              run.preview ? h('img', { src: previewUrl(run.preview), alt: '', style: { width: 44, height: 58, objectFit: 'cover', borderRadius: 6, flex: 'none', background: 'rgba(0,0,0,0.05)' } }) : h('div', { style: { width: 44, height: 58, borderRadius: 6, background: 'rgba(0,0,0,0.05)', flex: 'none' } }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  (run.kind === 'material' ? '[素材] ' : '') + (run.topic || run.name)),
                h('div', { style: { fontSize: 11.5, color: run.stage === 'published' ? '#0a7d43' : run.stage === 'uncertain' ? '#c0392b' : color.muted, marginTop: 2 } },
                  (stageLabel[run.stage] ?? (run.status === 'complete' ? '已创作' : run.status === 'waiting_agent' ? '等待 Agent' : '进行中'))
                    + (run.stage === 'published' && run.contentId ? ' · ' + run.contentId : '')
                    + (run.stage === 'published' && run.declarationStatus && run.declarationStatus !== 'SUBMITTED' ? ' · 声明待补' : ''))
              )
            ))
          )
        ),
        h('div', { style: styles.right },
          tasks.length ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '投稿任务 ' + tasks.length),
            h('span', { style: { fontSize: 11.5, color: color.muted } },
              '待投 ' + tasks.filter(row => row.status === 'queued').length + ' · 进行中 ' + tasks.filter(row => row.status === 'submitting').length),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', style: styles.button(false), onClick: () => setChecked(tasks.filter(row => row.status === 'queued').map(row => row.id)) }, '全选待投'),
            checked.length ? h('button', { type: 'button', style: styles.button(false), onClick: () => setChecked([]) }, '清空选择') : null,
            h('button', { type: 'button', style: styles.button(true), disabled: !!busy || (!checked.length && !tasks.some(row => row.status === 'queued')), onClick: () => (checked.length ? publishBatch() : startQueue()) },
              busy === 'batch' ? '批量投稿中…' : checked.length ? '批量投稿（' + checked.length + '）' : '全部待投依次投稿'),
            checked.length ? h('button', { type: 'button', style: styles.button(false), disabled: !!busy, onClick: cancelBatch },
              busy === 'cancel' ? '取消中…' : '批量取消（' + checked.length + '）') : null
          ) : null,
          queue ? h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, padding: '6px 10px', border: '1px solid ' + color.line, borderRadius: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: queue.running ? color.primary : color.muted } },
              queue.running ? '队列执行中' : '队列' + (queue.pending ? '（可续跑）' : '已结束')),
            h('span', { style: { fontSize: 11.5, color: color.muted } },
              '完成 ' + queue.done + ' · 失败 ' + queue.failed + ' · 待投 ' + queue.pending + ' / ' + queue.total),
            queue.running ? h('button', { type: 'button', style: styles.button(false), disabled: busy === 'queue', onClick: stopQueue }, '停止（当前件跑完即停）') : null,
            queue.pending ? h('button', { type: 'button', style: styles.button(true), disabled: busy === 'queue', onClick: startQueue }, '续跑剩余 ' + queue.pending + ' 件') : null,
            queue.failures?.length ? h('span', { style: { fontSize: 11.5, color: '#c0392b' } }, '失败：' + queue.failures.map(row => (row.topic || row.taskId) + '（' + row.error + '）').join('；').slice(0, 160)) : null
          ) : null,
          tasks.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, maxHeight: 220, overflow: 'auto' } },
            tasks.map(task => h('div', { key: task.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', border: '1px solid ' + color.line, borderRadius: 8 } },
              task.status === 'queued' ? h('input', { type: 'checkbox', checked: checked.includes(task.id), onChange: () => toggleCheck(task.id) }) : h('span', { style: { width: 13 } }),
              h('span', { style: { fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (task.kind === 'material' ? '[素材] ' : '[模板] ') + (task.topic || task.id)),
              task.run?.running
                ? h('span', { style: { fontSize: 11, color: color.primary } },
                  (task.run.step || '执行中') + ' · ' + Math.round((Date.now() - Date.parse(task.run.startedAt || Date.now())) / 1000) + 's')
                : h('span', { style: { fontSize: 11.5, color: publishStatusColor[task.status] || color.muted } }, publishStatusLabel[task.status] || task.status),
              task.status === 'queued' ? h('button', { type: 'button', style: { ...styles.button(false), padding: '2px 8px', fontSize: 11 }, onClick: async () => { await api.publishCancel(task.id); await loadTasks() } }, '取消') : null
            ))
          ) : null,
          !current ? h('div', { style: { color: color.muted, fontSize: 13.5, paddingTop: 40, textAlign: 'center' } }, '从左侧选择一个结果，检查图层分离与版权覆盖，然后创建投稿任务') : null,
          current ? h('div', null,
            h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start' } },
              current.preview ? h('img', { src: previewUrl(current.preview), alt: '', style: { width: 150, borderRadius: 10, border: '1px solid ' + color.line } }) : null,
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('h3', { style: { margin: '0 0 4px', fontSize: 17 } }, current.topic || current.name),
                h('div', { style: { fontSize: 11.5, color: color.muted } }, current.directory),
                h('div', { style: { marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 12.5, fontWeight: 700, color: passed || check?.published ? '#0a7d43' : '#c0392b' } },
                    busy === 'check' ? '检查中…'
                      : check?.published ? '已投稿，无需再次提交'
                        : check ? (passed ? '投稿前检查全部通过' : '投稿前检查未通过') : '尚未检查'),
                  check?.published ? null : h('button', { type: 'button', style: styles.button(passed && !task), disabled: !!busy || !passed || !!task, onClick: createPublish },
                    task ? '已创建投稿任务' : busy === 'create' ? '创建中…' : '创建投稿任务'),
                  task ? h('button', { type: 'button', style: styles.button(false), onClick: () => copy(task) }, copied === task.id ? '已复制' : '复制投稿指令') : null,
                  task && task.status === 'queued' ? h('button', { type: 'button', style: styles.button(false), onClick: () => removeTask(task.id) }, '删除任务') : null
                ),
                task ? h('div', { style: { fontSize: 11.5, color: publishStatusColor[task.status] || color.muted, marginTop: 6 } },
                  '投稿状态：' + (publishStatusLabel[task.status] || task.status)) : null
              )
            ),
            h('div', { style: styles.section },
              h('div', { style: styles.label }, '投稿前检查'),
              (check?.checks || []).map(row => h('div', { key: row.id, style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0' } },
                h('span', { style: { color: row.ok ? '#0a7d43' : row.id === 'not_published' && check?.published ? '#0a7d43' : '#c0392b', fontWeight: 700, width: 16 } }, row.ok ? '✓' : row.id === 'not_published' && check?.published ? '✓' : '✗'),
                h('span', { style: { fontSize: 12.5, minWidth: 160 } }, row.label),
                h('span', { style: { fontSize: 12, color: color.muted, flex: 1, wordBreak: 'break-word' } }, row.detail)
              )),
              busy === 'check' ? h('p', { style: { fontSize: 12.5, color: color.muted } }, '正在读取运行产物…') : null
            ),
            layers.length ? h('div', { style: styles.section },
              h('div', { style: styles.label }, '图层与按层版权（' + layers.length + ' 层）'),
              h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
                h('thead', null, h('tr', null,
                  ['图层', '类型', '版权分类', '透明分离', '隐藏审计'].map(title => h('th', { key: title, style: { textAlign: 'left', padding: '4px 6px', color: color.muted, fontWeight: 600, borderBottom: '1px solid ' + color.line } }, title))
                )),
                h('tbody', null, layers.map(row => h('tr', { key: row.id },
                  h('td', { style: { padding: '4px 6px', borderBottom: '1px solid ' + color.line } }, row.name),
                  h('td', { style: { padding: '4px 6px', borderBottom: '1px solid ' + color.line, color: color.muted } }, row.type),
                  h('td', { style: { padding: '4px 6px', borderBottom: '1px solid ' + color.line } }, row.type === 'image' ? (row.category || '—') : '—'),
                  h('td', { style: { padding: '4px 6px', borderBottom: '1px solid ' + color.line, color: row.alphaOk === false ? '#c0392b' : color.muted } }, row.type === 'image' ? (row.background ? '整幅背景' : row.alphaOk ? '有透明区' : '无透明像素') : '—'),
                  h('td', { style: { padding: '4px 6px', borderBottom: '1px solid ' + color.line, color: row.audited ? '#0a7d43' : color.muted } }, row.audited ? '已验收' : '未覆盖')
                )))
              )
            ) : null
          ) : null,
          error ? h('p', { style: { fontSize: 12.5, color: '#c0392b', marginTop: 10 } }, error) : null,
          h('div', { style: styles.section },
            h('div', { style: styles.label }, '投稿任务'),
            !tasks.length ? h('p', { style: { fontSize: 12.5, color: color.muted } }, '还没有投稿任务') : null,
            tasks.map(row => h('div', { key: row.id, style: { padding: '8px 0', borderBottom: '1px solid ' + color.line } },
              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
                h('span', { style: { fontSize: 12.5, fontWeight: 600, minWidth: 120 } }, row.topic || row.id),
                h('span', { style: { fontSize: 11.5, color: publishStatusColor[row.status] || color.muted } }, publishStatusLabel[row.status] || row.status),
                h('span', { style: { fontSize: 11, color: color.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.runDir),
                h('button', { type: 'button', style: styles.button(false), onClick: () => copy(row) }, copied === row.id ? '已复制' : '指令')
              ),
              row.run ? h('div', { style: { fontSize: 11.5, color: row.run.error ? '#c0392b' : color.primary, marginTop: 4 } },
                (row.run.running ? '投稿执行中 · ' : row.run.error ? '投稿中断 · ' : '投稿步骤完成 · ') + row.run.step,
                row.run.steps?.length ? '（' + row.run.steps.join(' → ') + '）' : '') : null,
              row.run?.error ? h('div', { style: { fontSize: 11.5, color: '#c0392b', marginTop: 2 } }, row.run.error) : null,
              row.status === 'queued' ? h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                h('button', { type: 'button', style: styles.button(false), disabled: !!busy, onClick: () => runPublishTask(row, false) }, busy === 'pd:' + row.id ? '执行中…' : '演练（不发布）'),
                h('button', { type: 'button', style: styles.button(true), disabled: !!busy, onClick: () => runPublishTask(row, true) }, busy === 'ps:' + row.id ? '提交中…' : '开始投稿')
              ) : null
            ))
          )
        )
      )
    }

    // 客户端汇总：追加分页后重新统计（服务端只给当前页的汇总）。
    function summarizeRows(rows) {
      const summary = { total: rows.length, clicks: 0, downloads: 0, editorUses: 0, byStatus: {}, byKind: { template: 0, material: 0 }, topics: {} }
      for (const row of rows) {
        summary.clicks += Number(row.clicks ?? 0)
        summary.downloads += Number(row.downloads ?? 0)
        summary.editorUses += Number(row.editorUses ?? 0)
        const name = auditState(row).text
        summary.byStatus[name] = (summary.byStatus[name] ?? 0) + 1
        summary.byKind[row.publishType === 2 ? 'material' : 'template']++
      }
      return summary
    }

    function PublishedTab() {
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [topicQuery, setTopicQuery] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [sort, setSort] = React.useState('recent')

      // 翻页：默认第 1 页；「加载更多」追加下一页，「加载全部」一次取全量。
      async function load(refresh, options = {}) {
        const nextPage = options.page ?? 1
        const append = options.append === true
        setBusy(append ? 'more' : 'load'); setError('')
        try {
          const value = await api.published({ refresh: refresh === true, page: nextPage, all: options.all === true })
          if (append && data) {
            const seen = new Set((data.rows || []).map(row => row.id))
            const merged = [...(data.rows || []), ...(value.rows || []).filter(row => !seen.has(row.id))]
            setData({ ...value, rows: merged, summary: summarizeRows(merged) })
          } else setData({ ...value, summary: value.summary ?? summarizeRows(value.rows || []) })
        } catch (e) { setError('读取已投稿失败：' + e.message) }
        finally { setBusy('') }
      }
      React.useEffect(() => { load(false) }, [])

      function exportCsv(list) {
        const header = ['作品ID', '标题', '类型', '审核状态', '声明状态', '话题', '浏览', '下载', '发布时间']
        const rowsCsv = list.map(row => [
          row.id, row.title ?? '', row.publishType === 2 ? '素材' : '模板', statusOf(row),
          row.declarationStatus ?? '', (row.topics ?? []).map(topic => topic.name).join(' / '),
          row.clicks ?? 0, row.downloads ?? 0, row.publishedAt ? new Date(Number(row.publishedAt)).toLocaleString('zh-CN') : ''
        ])
        const csv = [header, ...rowsCsv].map(cells => cells.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n')
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'gaoding-published-' + new Date().toISOString().slice(0, 10) + '.csv'
        anchor.click()
        URL.revokeObjectURL(url)
      }

      const rows = data?.rows ?? []
      const summary = data?.summary ?? null
      // 审核状态跟平台列表徽标对齐：看 audit_cqc_status 与 publish_status，不看 audit_status。
      const statusOf = row => auditState(row).text
      const kindOf = row => row.publishType === 2 ? 'material' : 'template'
      const sorted = [...rows].sort((a, b) => {
        if (sort === 'clicks') return Number(b.clicks ?? 0) - Number(a.clicks ?? 0)
        if (sort === 'downloads') return Number(b.downloads ?? 0) - Number(a.downloads ?? 0)
        return Number(b.publishedAt ?? 0) - Number(a.publishedAt ?? 0)
      })
      const visible = sorted.filter(row =>
        (!status || statusOf(row) === status)
        && (!kind || kindOf(row) === kind)
        && (!topicQuery || (row.title + ' ' + (row.topics ?? []).map(t => t.name).join(' ')).toLowerCase().includes(topicQuery.toLowerCase())))

      return h('div', { style: { flex: 1, overflow: 'auto', padding: '16px 22px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 17 } }, '已投稿作品'),
          summary ? h('span', { style: { fontSize: 12, color: color.muted } },
            (data?.hasMore ? '已加载 ' : '共 ') + summary.total + ' 件'
            + (data?.hasMore ? '（还有更多）' : '') +
            ' · 浏览 ' + summary.clicks + ' · 下载 ' + summary.downloads + ' · 编辑器使用 ' + summary.editorUses) : null,
          h('span', { style: { flex: 1 } }),
          data?.hasMore ? h('button', { type: 'button', style: styles.button(false), disabled: !!busy, onClick: () => load(false, { page: (data.page ?? 1) + 1, append: true }) },
            busy === 'more' ? '加载中…' : '加载更多') : null,
          data?.hasMore ? h('button', { type: 'button', style: styles.button(false), disabled: !!busy, onClick: () => load(true, { all: true }) },
            busy === 'load' ? '加载中…' : '加载全部') : null,
          h('button', { type: 'button', style: styles.button(false), disabled: !!busy, onClick: () => load(true) }, busy === 'load' ? '读取中…' : '刷新')
        ),
        summary ? h('div', { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          Object.entries(summary.byStatus).map(([name, count]) => h('button', {
            key: name, type: 'button',
            onClick: () => setStatus(status === name ? '' : name),
            style: { ...styles.chip(name === '审核不通过' ? 'warn' : name === '已通过' ? 'ok' : 'muted'), border: status === name ? '1px solid ' + color.primary : '1px solid transparent', cursor: 'pointer' }
          }, name + ' ' + count)),
          h('span', { style: styles.chip('muted') }, '模板 ' + summary.byKind.template),
          h('span', { style: styles.chip('muted') }, '素材 ' + summary.byKind.material)
        ) : null,
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' } },
          h('select', { value: status, onChange: e => setStatus(e.target.value), style: { ...styles.input, width: 130 } },
            h('option', { value: '' }, '全部状态'),
            ['审核中', '已通过', '审核不通过', '待声明'].map(name => h('option', { key: name, value: name }, name))
          ),
          h('select', { value: kind, onChange: e => setKind(e.target.value), style: { ...styles.input, width: 110 } },
            h('option', { value: '' }, '全部类型'),
            h('option', { value: 'template' }, '模板'),
            h('option', { value: 'material' }, '素材')
          ),
          h('input', { style: { ...styles.input, flex: 1, minWidth: 160 }, type: 'search', placeholder: '搜索标题或话题', value: topicQuery, onChange: e => setTopicQuery(e.target.value) }),
          h('select', { value: sort, onChange: e => setSort(e.target.value), style: { ...styles.input, width: 120 } },
            h('option', { value: 'recent' }, '按时间'),
            h('option', { value: 'clicks' }, '按浏览'),
            h('option', { value: 'downloads' }, '按下载')
          ),
          h('button', { type: 'button', style: styles.button(false), disabled: !visible.length, onClick: () => exportCsv(visible) }, '导出 CSV')
        ),
        error ? h('p', { style: { fontSize: 12.5, color: '#c0392b' } }, error) : null,
        !rows.length && busy !== 'load' ? h('p', { style: { fontSize: 13, color: color.muted } }, '还没有读到已投稿作品。') : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 } },
          visible.map(row => h('div', { key: row.id, style: { border: '1px solid ' + color.line, borderRadius: 12, overflow: 'hidden' } },
            row.preview ? h('img', { src: row.preview, alt: '', style: { width: '100%', aspectRatio: (row.width && row.height ? row.width + ' / ' + row.height : '3 / 4'), objectFit: 'cover', background: 'rgba(0,0,0,0.04)' } })
              : h('div', { style: { width: '100%', aspectRatio: '3 / 4', background: 'rgba(0,0,0,0.04)' } }),
            h('div', { style: { padding: '10px 12px' } },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, maxHeight: 36, overflow: 'hidden' } }, row.title || row.id),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                h('span', { style: styles.chip(statusOf(row) === '已通过' ? 'ok' : statusOf(row) === '审核中' ? 'muted' : 'warn') }, statusOf(row)),
                h('a', { href: 'https://gd.huaban.com/my/publish/' + row.id, target: '_blank', rel: 'noreferrer', style: { fontSize: 11.5, color: color.primary } }, '详情'),
                h('span', { style: styles.chip('muted') }, kindOf(row) === 'material' ? '素材' : '模板'),
                row.quality ? h('span', { style: styles.chip('muted') }, '质量 ' + row.quality) : null
              ),
              h('div', { style: { fontSize: 11, color: color.muted, marginTop: 6 } },
                '浏览 ' + (row.clicks ?? 0) + ' · 下载 ' + (row.downloads ?? 0) + ' · 使用 ' + (row.editorUses ?? 0)),
              (row.topics ?? []).length ? h('div', { style: { fontSize: 11, color: color.primary, marginTop: 4 } },
                row.topics.map(t => '#' + t.name).join(' ')) : null,
              row.rejectReason ? h('div', { style: { fontSize: 11, color: '#c0392b', marginTop: 4 } }, row.rejectReason) : null
            )
          ))
        )
      )
    }

    function ConsolePage() {
      const [preflight, setPreflight] = React.useState(null)
      const [preflightBusy, setPreflightBusy] = React.useState(false)
      const [tab, setTab] = React.useState('topics')
      const [catalog, setCatalog] = React.useState(null)
      const [specs, setSpecs] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [session, setSession] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [type, setType] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('topics')
      const [loadingDetail, setLoadingDetail] = React.useState(false)
      const [build, setBuild] = React.useState(null)
      const [stale, setStale] = React.useState(null)
      const [topicQuantity, setTopicQuantity] = React.useState(1)
      const [topicQuantityText, setTopicQuantityText] = React.useState('1')
      const [topicMode, setTopicMode] = React.useState('manual')
      const [topicMessage, setTopicMessage] = React.useState('')
      const started = React.useRef(false)

      const topics = catalog && catalog.status !== 'unavailable' ? (catalog.selectableTopics || catalog.topics || []) : []
      const specIndex = React.useMemo(() => {
        const map = new Map()
        for (const row of specs?.index || []) map.set(row.key, row)
        return map
      }, [specs])
      const failureIndex = React.useMemo(() => {
        const map = new Map()
        for (const row of specs?.failures || []) map.set(row.key, row)
        return map
      }, [specs])
      const visible = topics.filter(t => (!kind || (kind === 'material') === (t.publishKind === 'material'))
        && (!type || t.type === type)
        && (!query || (t.name + ' ' + (t.type || '')).toLowerCase().includes(query.toLowerCase())))

      // 话题页直接创建任务：不用切到创作 tab 再选一遍话题。
      async function createFromTopic() {
        if (!currentTopic?.rules_url) return
        setBusy('from-topic'); setError(''); setTopicMessage('')
        try {
          const value = await api.createJobs({
            topics: [currentTopic.key], quantity: topicQuantity, note: '', mode: topicMode, backend: 'gd-cli'
          })
          const count = value.jobs?.length ?? 0
          setTopicMessage('已创建 ' + count + ' 个任务（' + currentTopic.name + ' × ' + topicQuantity + '），去「创作」标签查看进度')
        } catch (error) { setError('创建任务失败：' + String(error?.message ?? error)) }
        finally { setBusy('') }
      }

      async function loadSpecs() {
        try { setSpecs(await api.specs()) } catch (e) { setError('规范库加载失败：' + e.message) }
      }
      async function loadTopics(refresh) {
        setBusy('topics'); setError('')
        try {
          let value = await api.topics(refresh)
          // 缓存过期又没有实时目录时，自动读一次登录浏览器，避免停在空列表。
          if (value.status === 'unavailable' && !refresh) value = await api.topics(true)
          setCatalog(value)
          if (value.status === 'unavailable') setError(value.error || '实时话题目录不可用，请先在浏览器登录创作者中心。')
        } catch (e) { setError('话题加载失败：' + e.message); setCatalog(null) }
        finally { setBusy('') }
      }
      async function pick(topic) {
        setSelected(topic.key); setDetail(null); setLoadingDetail(true)
        if (!topic.rules_url) { setLoadingDetail(false); return }
        try { setDetail(await api.spec(topic.key)) }
        catch (e) { if (!/还没有抓取/.test(e.message)) setError(e.message) }
        finally { setLoadingDetail(false) }
      }
      async function fetchOne() {
        if (!selected) return
        setBusy('one'); setError('')
        try {
          await api.refreshSpecs(false, selected)
          for (let i = 0; i < 40; i++) {
            const value = await api.specs()
            if (!value.job || !value.job.running) break
            await new Promise(resolve => setTimeout(resolve, 800))
          }
          await loadSpecs()
          const topic = topics.find(t => t.key === selected)
          if (topic) await pick(topic)
        } catch (e) { setError(e.message) }
        finally { setBusy('') }
      }
      async function refreshAll(force) {
        setBusy('all'); setError('')
        try {
          await api.refreshSpecs(force)
          await loadSpecs()
        } catch (e) { setError(e.message) }
        finally { setBusy('') }
      }
      async function probe() {
        setBusy('probe'); setError('')
        try { setSession(await api.probe()) } catch (e) { setError('登录检查失败：' + e.message) }
        finally { setBusy('') }
      }
      async function login() {
        setBusy('login'); setError('')
        try {
          const value = await api.login()
          setSession({ ...(session || {}), ...value })
        } catch (e) { setError('打开登录页失败：' + e.message) }
        finally { setBusy('') }
      }

      React.useEffect(() => {
        if (started.current) return
        started.current = true
        loadTopics(false)
        loadSpecs()
        api.session().then(setSession).catch(() => {})
        api.health().then(value => setBuild(value)).catch(() => {})
      }, [])

      // 插件重装后已打开的页面仍是旧 bundle；定时对比版本并提示刷新。
      React.useEffect(() => {
        if (!build?.version) return
        const timer = setInterval(() => {
          api.health().then(value => { if (value?.version && value.version !== build.version) setStale(value.version) }).catch(() => {})
        }, 60000)
        return () => clearInterval(timer)
      }, [build?.version])

      React.useEffect(() => {
        const job = specs?.job
        if (!job || !job.running) return
        const timer = setInterval(() => { loadSpecs() }, 1500)
        return () => clearInterval(timer)
      }, [specs?.job?.running])

      async function runPreflight(refresh) {
        setPreflightBusy(true)
        try { setPreflight(await api.preflight(refresh)) } catch (e) { setPreflight({ error: e.message }) } finally { setPreflightBusy(false) }
      }
      React.useEffect(() => { runPreflight(false) }, [])

      const job = specs?.job
      const missing = specs?.missing?.length ?? null
      const currentTopic = topics.find(t => t.key === selected) || null
      const sessionTone = session?.loggedIn === true ? 'ok' : session?.loggedIn === false ? 'warn' : 'muted'
      const sessionText = session?.loggedIn === true ? '已登录' + (session?.account?.id ? ' · ' + session.account.id : '') : session?.loggedIn === false ? '未登录' : '未检查'

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('strong', { style: { fontSize: 16 } }, '稿定投稿控制台'),
          h('span', { style: styles.chip(sessionTone) }, '登录状态：' + sessionText),
          h('span', { style: { fontSize: 11, color: color.muted, border: '1px solid ' + color.line, borderRadius: 999, padding: '2px 8px' } },
            build ? 'v' + build.version : '版本未知（请刷新页面）'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: styles.button(false), disabled: busy === 'probe' || busy === 'login', onClick: probe }, busy === 'probe' ? '检查中…' : '检查登录'),
          session?.loggedIn === true ? null : h('button', { type: 'button', style: styles.button(false), disabled: busy === 'login', onClick: login }, busy === 'login' ? '打开中…' : '去登录'),
          h('button', { type: 'button', style: styles.button(false), onClick: () => window.open('gaoding-publisher/docs/USAGE', '_blank', 'noopener') }, '使用教程'),
          h('button', { type: 'button', style: styles.button(false), disabled: busy === 'topics', onClick: () => loadTopics(true) }, busy === 'topics' ? '刷新中…' : '刷新话题')
        ),
        h('div', { style: { display: 'flex', gap: 6, padding: '10px 20px', borderBottom: '1px solid ' + color.line } },
          h('button', { type: 'button', style: styles.tab(tab === 'topics'), onClick: () => setTab('topics') }, '话题与规范'),
          h('button', { type: 'button', style: styles.tab(tab === 'create'), onClick: () => setTab('create') }, '创作'),
          h('button', { type: 'button', style: styles.tab(tab === 'results'), onClick: () => setTab('results') }, '结果与投稿'),
          h('button', { type: 'button', style: styles.tab(tab === 'published'), onClick: () => setTab('published') }, '已投稿')
        ),
        stale ? h('div', { style: { margin: 0, padding: '8px 20px', fontSize: 12.5, color: '#b36b00', background: 'rgba(255,170,0,0.10)', borderBottom: '1px solid ' + color.line, display: 'flex', gap: 10, alignItems: 'center' } },
          h('span', null, '插件已更新到 v' + stale + '，当前页面还是 v' + (build?.version ?? '?') + '。'),
          h('button', { type: 'button', style: styles.button(false), onClick: () => window.location.reload() }, '立即刷新')
        ) : null,
        preflight ? (() => {
          if (preflight.error) return h('div', { style: { padding: '8px 20px', fontSize: 12, color: '#b36b00', borderBottom: '1px solid ' + color.line } },
            '环境自检失败：' + preflight.error + ' ', h('button', { type: 'button', style: { ...styles.button(false), padding: '1px 8px', fontSize: 11 }, onClick: () => runPreflight(true) }, '重试'))
          const bad = preflight.blocking ?? []
          const warn = preflight.warnings ?? []
          if (!bad.length && !warn.length) {
            return h('div', { style: { padding: '5px 20px', fontSize: 11.5, color: '#0a7d43', borderBottom: '1px solid ' + color.line, display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', null, '环境自检通过：' + (preflight.checks ?? []).length + ' 项依赖就绪'),
              h('button', { type: 'button', style: { ...styles.button(false), padding: '1px 8px', fontSize: 11 }, disabled: preflightBusy, onClick: () => runPreflight(true) }, preflightBusy ? '检查中…' : '重新检查'))
          }
          return h('div', { style: { padding: '8px 20px', fontSize: 12, borderBottom: '1px solid ' + color.line, background: bad.length ? 'rgba(192,57,43,0.06)' : 'rgba(255,170,0,0.08)' } },
            h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 } },
              h('strong', { style: { color: bad.length ? '#c0392b' : '#b36b00' } },
                bad.length ? '有 ' + bad.length + ' 项依赖缺失，创作/投稿已禁用' : '环境可用，但有 ' + warn.length + ' 项需要留意'),
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', style: { ...styles.button(false), padding: '1px 8px', fontSize: 11 }, disabled: preflightBusy, onClick: () => runPreflight(true) }, preflightBusy ? '检查中…' : '重新检查')),
            [...bad, ...warn].map(row => h('div', { key: row.id, style: { fontSize: 11.5, color: bad.some(item => item.id === row.id) ? '#c0392b' : '#8a6d3b', marginTop: 2 } },
              '· ' + row.label + '：' + row.detail + (row.fix ? ' → ' + row.fix : '')))
          )
        })() : null,
        error ? h('p', { style: { margin: 0, padding: '8px 20px', fontSize: 12.5, color: '#c0392b', borderBottom: '1px solid ' + color.line } }, error) : null,
        tab === 'topics' ? h('div', { style: styles.body },
          h('div', { style: styles.left },
            h('div', { style: { padding: '10px 14px', borderBottom: '1px solid ' + color.line } },
              h('input', { style: styles.input, type: 'search', placeholder: '搜索话题名称', value: query, onChange: e => setQuery(e.target.value) }),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
                h('select', { value: type, onChange: e => setType(e.target.value), style: { ...styles.input, width: 130 } },
                  h('option', { value: '' }, '全部类型'),
                  ...[...new Set(topics.map(t => t.type).filter(Boolean))].map(t => h('option', { key: t, value: t }, t))
                ),
                h('span', { style: { flex: 1, fontSize: 11.5, color: color.muted } },
                  '共 ' + topics.length + ' 个 · 规范 ' + (specs?.covered ?? specs?.count ?? 0) + '/' + (specs?.expected ?? '?')
                )
              ),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
                [['', '全部'], ['template', '模板'], ['material', '素材']].map(([value, label]) => h('button', {
                  key: value || 'all', type: 'button', onClick: () => setKind(value),
                  style: { ...styles.button(kind === value), padding: '4px 10px', fontSize: 12 }
                }, label))
              ),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
                h('button', { type: 'button', style: styles.button(true), disabled: !!busy || !!job?.running, onClick: () => refreshAll(false) },
                  job?.running ? '抓取中 ' + job.done + '/' + job.total : missing == null ? '抓取规范' : '抓取缺失规范（' + missing + '）'),
                h('button', { type: 'button', style: styles.button(false), disabled: !!busy || !!job?.running, onClick: () => refreshAll(true) }, '全部重抓')
              ),
              job?.running ? h('div', { style: { marginTop: 8, height: 4, borderRadius: 2, background: 'rgba(0,0,0,0.08)' } },
                h('div', { style: { height: 4, borderRadius: 2, background: color.primary, width: Math.round((job.done / Math.max(1, job.total)) * 100) + '%' } })
              ) : null,
              job && !job.running && job.failed ? h('p', { style: { fontSize: 11.5, color: '#b36b00', margin: '6px 0 0' } }, '上次抓取失败 ' + job.failed + ' 个') : null
            ),
            h('div', { style: { flex: 1, overflow: 'auto' } },
              !topics.length ? h('p', { style: { padding: 16, fontSize: 13, color: color.muted } }, catalog?.status === 'unavailable' ? '实时话题目录不可用，请先在浏览器登录创作者中心后刷新。' : '正在加载话题…') : null,
              visible.map(topic => h(TopicRow, { key: topic.key, topic, spec: specIndex.get(topic.key), failure: failureIndex.get(topic.key), active: topic.key === selected, onClick: () => pick(topic) })),
              topics.length && !visible.length ? h('p', { style: { padding: 16, fontSize: 13, color: color.muted } }, '没有匹配的话题') : null
            )
          ),
          h('div', { style: styles.right },
            h(SpecDetail, { topic: currentTopic, spec: detail, failure: currentTopic ? failureIndex.get(currentTopic.key) : null, loading: loadingDetail, onFetch: fetchOne, busy: busy === 'one' }),
            currentTopic ? h('div', { style: { marginTop: 14, padding: 12, border: '1px solid ' + color.line, borderRadius: 10 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 13, fontWeight: 600 } }, '用这个话题创建创作任务'),
                h('span', { style: { flex: 1 } }),
                h('span', { style: styles.label }, '数量'),
                h('input', {
                  type: 'number', min: 1, max: 20, step: 1, value: topicQuantityText,
                  onChange: e => {
                    const raw = e.target.value
                    setTopicQuantityText(raw)
                    const parsed = Number(raw)
                    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) setTopicQuantity(Math.floor(parsed))
                  },
                  onBlur: () => {
                    const parsed = Number(topicQuantityText)
                    const fixed = Number.isFinite(parsed) ? Math.min(20, Math.max(1, Math.floor(parsed))) : 1
                    setTopicQuantity(fixed); setTopicQuantityText(String(fixed))
                  },
                  style: { ...styles.input, width: 80 }
                })
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                h('span', { style: styles.label }, '模式'),
                [['manual', '手动确认'], ['auto', '全自动']].map(([value, label]) => h('button', {
                  key: value, type: 'button', onClick: () => setTopicMode(value),
                  style: { ...styles.button(topicMode === value), padding: '4px 10px', fontSize: 12 }
                }, label)),
                h('span', { style: { flex: 1 } }),
                h('button', {
                  type: 'button', style: styles.button(true), disabled: !!busy || !currentTopic.rules_url,
                  onClick: createFromTopic
                }, busy === 'from-topic' ? '创建中…' : '创建创作任务')
              ),
              topicMessage ? h('p', { style: { fontSize: 11.5, color: '#0a7d43', margin: '8px 0 0' } }, topicMessage) : null,
              !currentTopic.rules_url ? h('p', { style: { fontSize: 11.5, color: color.muted, margin: '6px 0 0' } }, '这个话题还没有规范链接，先抓取规范再创建。') : null
            ) : null
          )
        ) : null,
        tab === 'create' ? h(CreateTab, { topics, specIndex, failureIndex, envBlocked: (preflight?.blocking?.length ?? 0) > 0 }) : null,
        tab === 'results' ? h(ResultsTab) : null,
        tab === 'published' ? h(PublishedTab) : null
      )
    }

    function apply(ctx) {
      // 左侧导航入口：id 与 main 的 key 一致，点击即切换到本面板。
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: panelId,
        order: 30,
        label: () => '稿定投稿'
      }, PanelIcon)))
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: panelId
      }, ConsolePage)))
    }

    return { name, inject, apply }
  }
})
