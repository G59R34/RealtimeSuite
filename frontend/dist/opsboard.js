/* RealtimeSuite live board (LAN kiosk). */
(function () {
  'use strict';

  var state = {
    settings: {
      autoFullscreen: false,
      soundAlerts: true,
      flashAlerts: true,
      brandingTitle: 'RealtimeSuite',
      brandingSubtitle: 'Operations Glance Board',
      horizonHours: 8,
      refreshSeconds: 30,
      features: { shifts: true, tasks: true, announcements: true, clock_in: true }
    },
    data: null,
    refreshTimer: null,
    lastUpdate: 0,
    seenCritical: {},
    online: false
  };

  var el = {
    title: document.getElementById('ob-title'),
    subtitle: document.getElementById('ob-subtitle'),
    announcement: document.getElementById('ob-announcement'),
    status: document.getElementById('ob-status'),
    clock: document.getElementById('ob-clock'),
    fullscreen: document.getElementById('ob-fullscreen'),
    current: document.getElementById('ob-current'),
    upcoming: document.getElementById('ob-upcoming'),
    unassigned: document.getElementById('ob-unassigned'),
    nowCount: document.getElementById('ob-now-count'),
    upcomingCount: document.getElementById('ob-upcoming-count'),
    unassignedCount: document.getElementById('ob-unassigned-count'),
    footerBrand: document.getElementById('ob-footer-brand'),
    footerUpdated: document.getElementById('ob-footer-updated'),
    kpi: {
      activeShifts: document.getElementById('kpi-active-shifts'),
      upcomingShifts: document.getElementById('kpi-upcoming-shifts'),
      activeTasks: document.getElementById('kpi-active-tasks'),
      upcomingTasks: document.getElementById('kpi-upcoming-tasks'),
      unassignedTasks: document.getElementById('kpi-unassigned-tasks'),
      exceptions: document.getElementById('kpi-exceptions')
    }
  };

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function clockTime(value) {
    var date = new Date(value);
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function toObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function applySettings(raw) {
    var config = toObject(raw);
    var settings = toObject(config.opsboard_settings || config.rocview_settings);
    if (settings.branding_title) state.settings.brandingTitle = String(settings.branding_title);
    if (settings.branding_subtitle) state.settings.brandingSubtitle = String(settings.branding_subtitle);
    if (typeof settings.auto_fullscreen === 'boolean') state.settings.autoFullscreen = settings.auto_fullscreen;
    if (typeof settings.sound_alerts === 'boolean') state.settings.soundAlerts = settings.sound_alerts;
    if (typeof settings.flash_alerts === 'boolean') state.settings.flashAlerts = settings.flash_alerts;
    var horizon = Number(settings.default_horizon_hours);
    if (horizon >= 1 && horizon <= 48) state.settings.horizonHours = horizon;
    var refresh = Number(settings.default_refresh_seconds);
    if (refresh >= 10 && refresh <= 300) state.settings.refreshSeconds = refresh;
    var features = toObject(config.feature_flags);
    for (var key in state.settings.features) {
      if (typeof features[key] === 'boolean') state.settings.features[key] = features[key];
    }
  }

  function featureOn(name) {
    return state.settings.features[name] !== false;
  }

  function setPanelHidden(node, hidden) {
    var panel = node && node.closest ? node.closest('article') : null;
    if (panel) panel.hidden = hidden;
  }

  function setStatus(kind, label) {
    el.status.className = 'ob-status ' + kind;
    el.status.textContent = label;
  }

  function employeeName(employeesById, id) {
    var employee = employeesById[id];
    if (!employee) return 'Unassigned';
    return employee.full_name || employee.email || 'Employee';
  }

  function areaName(areasById, id) {
    var area = areasById[id];
    return area ? area.name : 'No work area';
  }

  function buildViewModel(data) {
    var nowMs = Date.now();
    var employeesById = {};
    data.employees.forEach(function (employee) {
      employeesById[employee.id] = employee;
    });
    var areasById = {};
    data.work_areas.forEach(function (area) {
      areasById[area.id] = area;
    });

    var assignmentsByTask = {};
    data.task_assignments.forEach(function (assignment) {
      var bucket = assignmentsByTask[assignment.task_id] || [];
      bucket.push(assignment);
      assignmentsByTask[assignment.task_id] = bucket;
    });
    var assignedTaskIds = {};
    data.task_assignments.forEach(function (assignment) {
      assignedTaskIds[assignment.task_id] = true;
    });

    var current = [];
    var upcoming = [];
    var criticalIds = [];

    if (featureOn('shifts')) data.shifts.forEach(function (shift) {
      var start = new Date(shift.start_at).getTime();
      var end = new Date(shift.end_at).getTime();
      var late = shift.clocked_in_at && start && new Date(shift.clocked_in_at).getTime() > start + 5 * 60000;
      var item = {
        kind: 'shift',
        title: employeeName(employeesById, shift.employee_id),
        owner: areaName(areasById, shift.work_area_id),
        when: clockTime(shift.start_at) + ' – ' + clockTime(shift.end_at),
        status: shift.status,
        late: Boolean(late),
        pool: Boolean(shift.is_shift_pool),
        start: start,
        end: end
      };
      if (start <= nowMs && end >= nowMs) current.push(item);
      else if (start > nowMs) upcoming.push(item);
    });

    if (featureOn('tasks')) data.tasks.forEach(function (task) {
      var start = new Date(task.start_at).getTime();
      var end = new Date(task.end_at).getTime();
      var assignments = assignmentsByTask[task.id] || [];
      var unacknowledged = assignments.length > 0 && assignments.some(function (assignment) {
        return !assignment.acknowledged_at;
      });
      var item = {
        kind: 'task',
        title: task.title || 'Task',
        owner: assignments.length
          ? assignments.map(function (assignment) { return employeeName(employeesById, assignment.employee_id); }).join(', ')
          : 'Unassigned',
        area: areaName(areasById, task.work_area_id),
        detail: task.priority + ' · ' + task.status,
        when: clockTime(task.start_at) + ' – ' + clockTime(task.end_at),
        priority: task.priority,
        unacknowledged: unacknowledged,
        unassigned: !assignedTaskIds[task.id],
        start: start,
        end: end
      };
      if (item.priority === 'critical' && (item.unassigned || item.unacknowledged)) {
        criticalIds.push('task:' + task.id);
      }
      if (start <= nowMs && end >= nowMs) current.push(item);
      else if (start > nowMs) upcoming.push(item);
    });

    var unassignedTasks = (featureOn('tasks') ? data.tasks : []).filter(function (task) {
      return !assignedTaskIds[task.id] && task.status !== 'cancelled';
    }).map(function (task) {
      return {
        kind: 'task',
        title: task.title || 'Task',
        owner: areaName(areasById, task.work_area_id),
        when: clockTime(task.start_at) + ' – ' + clockTime(task.end_at),
        priority: task.priority
      };
    });

    function byStart(a, b) {
      return a.start - b.start;
    }

    current.sort(byStart);
    upcoming.sort(byStart);

    return {
      current: current,
      upcoming: upcoming,
      unassigned: unassignedTasks,
      criticalIds: criticalIds,
      counts: {
        activeShifts: current.filter(function (item) { return item.kind === 'shift'; }).length,
        upcomingShifts: upcoming.filter(function (item) { return item.kind === 'shift'; }).length,
        activeTasks: current.filter(function (item) { return item.kind === 'task'; }).length,
        upcomingTasks: upcoming.filter(function (item) { return item.kind === 'task'; }).length,
        unassignedTasks: unassignedTasks.length,
        exceptions: current.filter(function (item) { return item.kind === 'shift' && item.late; }).length
      }
    };
  }

  function renderItem(item) {
    var li = document.createElement('li');
    li.className = item.kind;
    if (item.kind === 'task' && item.priority === 'critical' && (item.unassigned || item.unacknowledged)) {
      li.className = 'task critical';
    }

    var row = document.createElement('div');
    row.className = 'ob-row';
    var title = document.createElement('strong');
    title.textContent = item.title;
    var when = document.createElement('span');
    when.className = 'ob-when';
    when.textContent = item.when;
    row.appendChild(title);
    row.appendChild(when);
    li.appendChild(row);

    var owner = document.createElement('span');
    owner.className = 'ob-owner';
    owner.textContent = item.kind === 'shift'
      ? item.owner + (item.status ? ' · ' + String(item.status).replace('_', ' ') : '')
      : item.owner + (item.detail ? ' · ' + item.detail : '');
    li.appendChild(owner);

    if (item.kind === 'shift' && item.late) {
      var late = document.createElement('span');
      late.className = 'ob-tag danger';
      late.textContent = 'Late clock-in';
      li.appendChild(late);
    }
    if (item.kind === 'shift' && item.pool) {
      var pool = document.createElement('span');
      pool.className = 'ob-tag';
      pool.textContent = 'Shift pool';
      li.appendChild(pool);
    }
    if (item.kind === 'task' && item.unassigned) {
      var unassigned = document.createElement('span');
      unassigned.className = 'ob-tag warn';
      unassigned.textContent = 'Unassigned';
      li.appendChild(unassigned);
    }
    if (item.kind === 'task' && item.unacknowledged) {
      var ack = document.createElement('span');
      ack.className = 'ob-tag warn';
      ack.textContent = 'Awaiting acknowledgement';
      li.appendChild(ack);
    }

    return li;
  }

  function renderList(node, items, emptyText, limit) {
    node.textContent = '';
    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'ob-empty';
      empty.textContent = emptyText;
      node.appendChild(empty);
      return;
    }
    items.slice(0, limit || items.length).forEach(function (item) {
      node.appendChild(renderItem(item));
    });
  }

  function alertCritical(criticalIds) {
    var hasNew = criticalIds.some(function (id) { return !state.seenCritical[id]; });
    state.seenCritical = {};
    criticalIds.forEach(function (id) { state.seenCritical[id] = true; });
    if (!hasNew) return;

    if (state.settings.soundAlerts) {
      try {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          var ctx = new AudioCtx();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 760;
          gain.gain.value = 0.0001;
          var at = ctx.currentTime;
          gain.gain.exponentialRampToValueAtTime(0.06, at + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
          osc.start(at);
          osc.stop(at + 0.28);
          setTimeout(function () { void ctx.close(); }, 400);
        }
      } catch (err) {
        /* audio is optional */
      }
    }

    if (state.settings.flashAlerts) {
      document.body.classList.remove('flash-critical');
      void document.body.offsetWidth;
      document.body.classList.add('flash-critical');
    }
  }

  function render(data) {
    var view = buildViewModel(data);
    el.title.textContent = state.settings.brandingTitle;
    el.subtitle.textContent = state.settings.brandingSubtitle;
    el.announcement.textContent = featureOn('announcements')
      ? (data.announcement || 'No active announcements')
      : '';
    el.announcement.hidden = !featureOn('announcements');
    el.footerBrand.textContent = (data.organization && data.organization.name ? data.organization.name : 'RealtimeSuite') + ' · Local Network';

    el.kpi.activeShifts.textContent = String(view.counts.activeShifts);
    el.kpi.upcomingShifts.textContent = String(view.counts.upcomingShifts);
    el.kpi.activeTasks.textContent = String(view.counts.activeTasks);
    el.kpi.upcomingTasks.textContent = String(view.counts.upcomingTasks);
    el.kpi.unassignedTasks.textContent = String(view.counts.unassignedTasks);
    el.kpi.exceptions.textContent = String(view.counts.exceptions);
    setPanelHidden(el.kpi.activeShifts, !featureOn('shifts'));
    setPanelHidden(el.kpi.upcomingShifts, !featureOn('shifts'));
    setPanelHidden(el.kpi.activeTasks, !featureOn('tasks'));
    setPanelHidden(el.kpi.upcomingTasks, !featureOn('tasks'));
    setPanelHidden(el.kpi.unassignedTasks, !featureOn('tasks'));
    setPanelHidden(el.kpi.exceptions, !featureOn('clock_in'));
    setPanelHidden(el.unassigned, !featureOn('tasks'));

    el.nowCount.textContent = String(view.current.length);
    el.upcomingCount.textContent = String(view.upcoming.length);
    el.unassignedCount.textContent = String(view.unassigned.length);

    renderList(el.current, view.current, 'Nothing scheduled right now.', 14);
    renderList(el.upcoming, view.upcoming, 'No upcoming work in this horizon.', 18);
    renderList(el.unassigned, view.unassigned, 'All tasks are assigned.', 20);

    alertCritical(view.criticalIds);
  }

  function scheduleRefresh() {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(refresh, state.settings.refreshSeconds * 1000);
  }

  function token() {
    var params = new URLSearchParams(window.location.search);
    return params.get('token') || window.localStorage.getItem('realtimesuite_kiosk_token') || '';
  }

  function refresh() {
    setStatus('syncing', 'Refreshing…');
    var query = '?horizon_hours=' + encodeURIComponent(state.settings.horizonHours);
    var key = token();
    if (key) query += '&token=' + encodeURIComponent(key);

    fetch('/api/opsboard' + query, { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('Board request failed (' + response.status + ').');
        return response.json();
      })
      .then(function (data) {
        state.data = data;
        state.online = true;
        state.lastUpdate = Date.now();
        if (data.organization && data.organization.experience_builder_config) {
          applySettings(data.organization.experience_builder_config);
        }
        render(data);
        setStatus('online', 'Live');
        el.footerUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
        if (state.settings.autoFullscreen && document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(function () { /* ignore */ });
        }
      })
      .catch(function (error) {
        state.online = false;
        setStatus('error', 'Offline');
        el.footerUpdated.textContent = error && error.message ? error.message : 'Board unavailable.';
      })
      .then(scheduleRefresh);
  }

  el.fullscreen.addEventListener('click', function () {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () { /* ignore */ });
    }
  });

  window.setInterval(function () {
    el.clock.textContent = new Date().toLocaleTimeString([], { hour12: false });
    if (state.lastUpdate && Date.now() - state.lastUpdate > state.settings.refreshSeconds * 3500) {
      el.footerUpdated.textContent = 'Data may be stale';
    }
  }, 1000);

  refresh();
})();
