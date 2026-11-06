/**
 * 可视化话题选择面板：会话头部「投稿」按钮 → 弹层勾选话题 → 开始后把指令写入输入框并发送。
 * 客户端 bundle 采用 DSH 的 ModuleLoader 协议（无需构建）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-gaoding-publisher',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const name = 'dsh-plugin-gaoding-publisher-client'
    const inject = ['slots']

    const TOPICS = [
      { key: 'birthday', name: '偶像生日应援局', spec: '小红书 1242×1656，姓名/日期/祝福，粉丝站应援' },
      { key: 'drama', name: '向全世界安利新剧', spec: '手机海报 1242×2208/小红书 1656，角色安利/开播提醒' },
      { key: 'goods', name: '应援周边自己做', spec: '小卡/明信片/手幅/吧唧/票根 + 展示海报' },
      { key: 'concert', name: '我的演唱会现场', spec: '手机海报 1242×2208，现场感/灯海/票根' },
      { key: 'tour', name: '演唱会宣传出圈', spec: '手机海报 1242×2208，大字标题 + 票务分层' }
    ]

    function buildPrompt(selected) {
      const rows = TOPICS.filter((t) => selected.includes(t.key))
      return [
        '请使用 gaoding-publisher 技能，为以下话题制作并投稿模板（全自动执行，中途不要向我确认）：',
        ...rows.map((t) => '- ' + t.name + '（key: ' + t.key + '）'),
        '',
        '完成标准：话题研究 → Agent 创意母稿 → 独立分层 → 可编辑 PSD → 编辑器导入与字体 → 投稿（话题 chip + 参与活动 + AI 标记）→ 版权声明 → 发布管理核验 → 交付素材包。',
        '最后汇报每个话题的作品链接、审核状态、图片/文字层数、素材 ZIP 路径。',
        '先调用 gaoding_topics 读取完整指引和当前规范摘要，再按我选定的 key 登记；执行中以详情页实际规范为准。'
      ].join('\n')
    }

    function apply(ctx) {
      const uiText = (zh, en) => zh

      function TopicPanel(props) {
        const [selected, setSelected] = React.useState([])
        const [open, setOpen] = React.useState(false)
        const [error, setError] = React.useState('')
        const inputActions = props.inputActions

        function toggle(key) {
          setSelected((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : prev.concat(key))
          setError('')
        }

        async function start() {
          if (!selected.length) { setError('请至少选择一个话题'); return }
          if (!inputActions || typeof inputActions.captureInsertion !== 'function') { setError('当前会话输入框不可用，请打开一个空白会话后重试'); return }
          const text = buildPrompt(selected)
          try {
            const span = inputActions.captureInsertion()
            const inserted = inputActions.insertText(text, span)
            if (!inserted) { setError('写入输入框失败，请点击输入框后再试'); return }
            setOpen(false)
            setSelected([])
            inputActions.submit()
          } catch (e) { setError('启动失败：' + String(e && e.message ? e.message : e)) }
        }

        const overlay = open ? React.createElement('div', {
          key: 'overlay',
          onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) },
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(8,10,16,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24
          }
        }, React.createElement('div', {
          style: {
            width: 'min(520px, 92vw)', maxHeight: '82vh', overflow: 'auto', borderRadius: 16, padding: '20px 22px',
            background: 'var(--dsw-alias-bg-layer-3, #ffffff)', color: 'var(--dsw-alias-label-primary, #101418)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.35)', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))'
          }
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
            React.createElement('h3', { style: { margin: 0, fontSize: 17 } }, uiText('选择要投稿的话题', 'Choose topics')),
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6b7280)' } }, '选中后 Agent 全自动执行')
          ),
          React.createElement('p', { style: { margin: '8px 0 14px', fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, #6b7280)' } },
            '流程：研究 → 创意母稿 → 分层 → PSD → 导入 → 投稿 → 版权声明 → 核验。选定后不再询问。'),
          ...TOPICS.map((t) => React.createElement('label', {
            key: t.key,
            style: {
              display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 8, cursor: 'pointer',
              borderRadius: 10, border: '1px solid ' + (selected.includes(t.key) ? 'var(--dsw-alias-state-business-primary, #2f6cf6)' : 'var(--dsw-alias-border-l2, rgba(0,0,0,0.1))'),
              background: selected.includes(t.key) ? 'var(--dsw-alias-interactive-bg-hover, rgba(47,108,246,0.06))' : 'transparent'
            }
          },
            React.createElement('input', { type: 'checkbox', checked: selected.includes(t.key), onChange: () => toggle(t.key), style: { marginTop: 3, accentColor: 'var(--dsw-alias-state-business-primary, #2f6cf6)' } }),
            React.createElement('span', null,
              React.createElement('span', { style: { display: 'block', fontSize: 14, fontWeight: 600 } }, t.name),
              React.createElement('span', { style: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6b7280)' } }, t.spec)
            )
          )),
          error ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: 12.5, margin: '2px 0 10px' } }, error) : null,
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 } },
            React.createElement('button', { type: 'button', onClick: () => setOpen(false), style: { padding: '8px 16px', borderRadius: 9, border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '取消'),
            React.createElement('button', { type: 'button', onClick: start, style: { padding: '8px 18px', borderRadius: 9, border: 'none', background: 'var(--dsw-alias-state-business-primary, #2f6cf6)', color: '#fff', fontWeight: 600, cursor: 'pointer' } },
              '开始投稿' + (selected.length ? '（' + selected.length + '）' : ''))
          )
        )) : null

        return React.createElement(React.Fragment, null,
          React.createElement('button', {
            type: 'button',
            title: '选择话题并自动投稿',
            onClick: () => setOpen(true),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', marginRight: 6,
              borderRadius: 15, border: '1px solid rgba(47,108,246,0.35)', background: 'rgba(47,108,246,0.08)',
              color: 'var(--dsw-alias-state-business-primary, #2f6cf6)', fontSize: 13, fontWeight: 600, cursor: 'pointer'
            }
          }, '投稿'),
          // 头部槽位位于会话框架的一个层叠上下文里，fixed 弹层可能被兄弟层盖住；
          // 通过 portal 挂到 body 末尾，保证遮罩和面板始终在应用内容之上。
          overlay && typeof ReactDOM.createPortal === 'function'
            ? ReactDOM.createPortal(overlay, document.body)
            : overlay
        )
      }

      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'gaoding-publisher',
        order: 90
      }, TopicPanel)))
    }

    return { name, inject, apply }
  }
})
