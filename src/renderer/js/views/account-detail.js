window.App = window.App || {};
App.Views = App.Views || {};

App.Views.AccountDetail = (function() {
  async function render(container, acctId) {
    container.innerHTML = '';
    App.Spinner.show(container, '加载账号详情...');

    try {
      var r = await App.API.getAccount(acctId);
      if (!r || !r.success || !r.data) throw new Error('账号不存在');
      var a = r.data;
      App.Spinner.clear(container);

      container.appendChild(App.el('div', { className: 'detail-page' },
        App.el('div', { className: 'detail-header' },
          App.el('button', { className: 'detail-back', onClick: function() { window.location.hash = '#accounts'; } }, '←'),
          App.el('div', { style: 'flex:1;min-width:0;' },
            App.el('div', { className: 'detail-title' }, a.email),
            App.el('div', { style: 'font-size:12px;color:hsl(var(--text-400));margin-top:2px;' }, (a.plan_type || 'plus').toUpperCase() + ' · gen ' + a.token_generation + ' · ' + App.formatDate(a.last_used))
          ),
          App.el('button', { className: 'btn btn-primary', onClick: function() { handleSwitch(a); } }, '⇄ 切换到此账号')
        ),

        // Token 状态
        App.el('div', { className: 'detail-section' },
          App.el('div', { className: 'detail-section-title' }, 'Token 状态'),
          App.el('div', { className: 'detail-row' }, App.el('span', { className: 'key' }, '状态'), App.TokenStatus.create(a)),
          App.el('div', { className: 'detail-row' }, App.el('span', { className: 'key' }, 'Refresh Token'), App.el('span', { className: 'val' }, a.tokens && a.tokens.refresh_token ? '✓ 可用' : '✗ 无')),
          App.el('div', { style: 'margin-top:12px;' },
            App.el('button', { className: 'btn btn-sm', onClick: function() { handleRefreshToken(a); } }, '🔄 刷新 Token')
          )
        ),

        // 配额
        App.el('div', { className: 'detail-section' },
          App.el('div', { className: 'detail-section-title' }, '配额使用'),
          a.quota ? App.el('div', { style: 'display:flex;flex-direction:column;gap:12px;' },
            App.QuotaBar.create(a.quota.hourly_percentage, '5h 配额'),
            a.quota.weekly_window_present ? App.QuotaBar.create(a.quota.weekly_percentage, '周配额') : null,
            a.quota.hourly_reset_time ? App.el('div', { style: 'font-size:12px;color:hsl(var(--text-400));' }, '重置倒计时: ' + App.formatExpiry(a.quota.hourly_reset_time)) : null,
            a.quota.reset_credits_available ? App.el('div', { style: 'font-size:13px;color:hsl(var(--brand-000));' }, '🎖 可用重置次数: ' + a.quota.reset_credits_available) : null,
            App.el('div', { style: 'margin-top:8px;' },
              App.el('button', { className: 'btn btn-sm', onClick: function() { handleRefreshQuota(a); } }, '🔄 刷新配额')
            )
          ) : App.el('p', { style: 'color:hsl(var(--text-400));font-size:13px;' }, '暂无配额数据'),
          a.quota_error ? App.el('p', { style: 'color:hsl(var(--danger-100));font-size:12px;margin-top:8px;' }, '⚠ ' + a.quota_error.message) : null
        ),

        // 重置额度
        App.el('div', { className: 'detail-section' },
          App.el('div', { className: 'detail-section-title' }, '主动重置额度'),
          (a.reset_credits && a.reset_credits.available_count > 0
            ? App.el('div', {},
                App.el('p', { style: 'font-size:13px;' }, '可用次数: ' + a.reset_credits.available_count),
                App.el('div', { style: 'margin-top:8px;display:flex;gap:8px;' },
                  App.el('button', { className: 'btn btn-sm', onClick: function() { handleFetchCredits(a); } }, '🔄 查询'),
                  App.el('button', { className: 'btn btn-sm btn-primary', onClick: function() { handleConsumeCredit(a); } }, '消耗一个')
                )
              )
            : App.el('div', {},
                App.el('p', { style: 'color:hsl(var(--text-400));font-size:13px;' }, '暂无可用的主动重置额度'),
                App.el('button', { className: 'btn btn-sm', style: 'margin-top:8px;', onClick: function() { handleFetchCredits(a); } }, '🔄 查询重置额度')
              )
          )
        ),

        // 订阅
        App.el('div', { className: 'detail-section' },
          App.el('div', { className: 'detail-section-title' }, '订阅信息'),
          App.el('div', { className: 'detail-row' }, App.el('span', { className: 'key' }, '计划'), App.el('span', { className: 'val' }, (a.plan_type || '?').toUpperCase())),
          App.el('div', { className: 'detail-row' }, App.el('span', { className: 'key' }, '订阅到期'),
            a.subscription_active_until ? App.el('span', { className: 'val' }, a.subscription_active_until + ' (' + App.formatExpiry(Math.floor(new Date(a.subscription_active_until).getTime()/1000)) + ')') : App.el('span', { className: 'val', style: 'color:hsl(var(--text-400));' }, '未知')
          ),
          App.el('div', { style: 'margin-top:8px;' },
            App.el('button', { className: 'btn btn-sm', onClick: function() { handleRefreshSub(a); } }, '🔄 刷新订阅')
          )
        ),

        // 危险操作
        App.el('div', { className: 'detail-section', style: 'border-color:hsl(var(--danger-200)/0.3);' },
          App.el('div', { className: 'detail-section-title', style: 'color:hsl(var(--danger-100));' }, '危险操作'),
          App.el('div', { className: 'detail-row' },
            App.el('span', { className: 'key' }, '删除此账号'),
            App.el('button', { className: 'btn btn-sm btn-danger', onClick: function() { handleDelete(a); } }, '🗑 删除')
          )
        )
      ));
    } catch(e) {
      App.Spinner.clear(container);
      container.innerHTML = '<div class="empty-state"><div class="empty-state-title">加载失败</div><div class="empty-state-desc">' + e.message + '</div></div>';
    }
  }

  async function handleSwitch(a) {
    App.Toast.info('正在切换...');
    try { var r = await App.API.switchAccount(a.id); if (r && r.success) App.Toast.success('已切换到 ' + a.email); else throw new Error(r.error); } catch(e) { App.Toast.error(e.message); }
  }

  async function handleRefreshToken(a) {
    App.Toast.info('正在刷新...');
    try { var r = await App.API.refreshToken(a.id); if (r && r.success && r.data) { App.Toast.success('Token 刷新成功 (gen ' + r.data.gen + ')'); window.location.hash = '#detail/' + a.id; } else throw new Error(r.error || '刷新失败'); } catch(e) { App.Toast.error(e.message); }
  }

  async function handleRefreshQuota(a) {
    App.Toast.info('正在获取配额...');
    try { var r = await App.API.refreshQuota(a.id); if (r && r.success) { App.Toast.success('配额已刷新'); window.location.hash = '#detail/' + a.id; } else throw new Error(r.error); } catch(e) { App.Toast.error(e.message); }
  }

  async function handleFetchCredits(a) {
    App.Toast.info('正在查询...');
    try { var r = await App.API.fetchResetCredits(a.id); if (r && r.success) { App.Toast.success(r.data.available_count + ' 次重置额度可用'); window.location.hash = '#detail/' + a.id; } else throw new Error(r.error); } catch(e) { App.Toast.error(e.message); }
  }

  async function handleConsumeCredit(a) {
    if (!confirm('确定消耗一个重置额度？')) return;
    App.Toast.info('正在消耗...');
    try { var r = await App.API.consumeResetCredit(a.id); if (r && r.success) { App.Toast.success('重置额度已消耗'); window.location.hash = '#detail/' + a.id; } else throw new Error(r.error); } catch(e) { App.Toast.error(e.message); }
  }

  async function handleRefreshSub(a) {
    App.Toast.info('正在刷新订阅...');
    try { var r = await App.API.refreshSubscription(a.id, true); if (r && r.success) { App.Toast.success('订阅已刷新'); window.location.hash = '#detail/' + a.id; } else throw new Error(r.error); } catch(e) { App.Toast.error(e.message); }
  }

  async function handleDelete(a) {
    if (!confirm('确定删除 ' + a.email + '？')) return;
    try { await App.API.deleteAccount(a.id); App.Toast.success('已删除'); window.location.hash = '#accounts'; } catch(e) { App.Toast.error(e.message); }
  }

  return { render: render };
})();
