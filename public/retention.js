export function mountRetention({api, notice, busy, date, table, button}) {
  let eligibleEntities = [];
  let currentPreview = null;
  let activeJobId = null;
  let passwordResolver = null;
  let passwordRejecter = null;

  const $ = selector => document.querySelector(selector);

  // Setup Password Modal
  const modal = $('#retention-password-modal');
  const modalForm = $('#retention-password-form');
  const modalPasswordInput = $('#retention-modal-password');
  const modalPromptText = $('#modal-prompt-text');
  const modalCancelBtn = $('#retention-modal-cancel');

  function openPasswordModal(promptMessage) {
    return new Promise((resolve, reject) => {
      passwordResolver = resolve;
      passwordRejecter = reject;
      modalPromptText.textContent = promptMessage || 'Vui lòng nhập mật khẩu quản trị để tiếp tục.';
      modalPasswordInput.value = '';
      modal.hidden = false;
      modalPasswordInput.focus();
    });
  }

  function closePasswordModal(cancelled = false) {
    modal.hidden = true;
    modalPasswordInput.value = '';
    if (cancelled && passwordRejecter) {
      passwordRejecter(new Error('Đã hủy xác nhận mật khẩu.'));
    }
    passwordResolver = null;
    passwordRejecter = null;
  }

  modalCancelBtn.addEventListener('click', () => closePasswordModal(true));
  modal.addEventListener('click', e => {
    if (e.target === modal) closePasswordModal(true);
  });

  modalForm.addEventListener('submit', e => {
    e.preventDefault();
    const pw = modalPasswordInput.value;
    if (passwordResolver) passwordResolver(pw);
    closePasswordModal(false);
  });

  // Render Eligible Entities Checkboxes
  function renderEntityCheckboxes() {
    const container = $('#retention-entities-selector');
    container.replaceChildren();
    if (!eligibleEntities.length) {
      container.textContent = 'Không có loại dữ liệu hợp lệ để dọn.';
      return;
    }
    for (const name of eligibleEntities) {
      const label = document.createElement('label');
      label.className = 'entity-checkbox-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.name = 'manualEntities';
      cb.addEventListener('change', invalidatePreview);
      label.append(cb, ' ' + name);
      container.append(label);
    }
  }

  function invalidatePreview() {
    currentPreview = null;
    $('#retention-preview-box').hidden = true;
  }

  $('#manual-date-from').addEventListener('change', invalidatePreview);
  $('#manual-date-to').addEventListener('change', invalidatePreview);

  $('#manual-select-all').addEventListener('click', () => {
    document.querySelectorAll('input[name="manualEntities"]').forEach(cb => { cb.checked = true; });
    invalidatePreview();
  });

  $('#manual-deselect-all').addEventListener('click', () => {
    document.querySelectorAll('input[name="manualEntities"]').forEach(cb => { cb.checked = false; });
    invalidatePreview();
  });

  $('#manual-cancel-preview-btn').addEventListener('click', invalidatePreview);

  // Render Auto Policies
  function renderPolicies(policies) {
    table('#retention-policies-table', policies || [], p => [
      p.entity || 'Tất cả loại dữ liệu',
      p.retention_days + ' ngày',
      p.schedule_hhmm + ' (VN)',
      p.enabled ? 'Đang bật' : 'Đang tắt',
      date(p.last_run_at),
      p.enabled ? date(p.next_run_at) : '—'
    ]);
  }

  // Load Retention Data
  async function loadRetentionData() {
    try {
      const res = await api('/admin/retention/policies');
      eligibleEntities = res.entities || [];

      // Populate auto policy entity select
      const select = $('#retention-auto-entity');
      select.innerHTML = '<option value="">Tất cả loại dữ liệu hợp lệ</option>';
      for (const name of eligibleEntities) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.append(opt);
      }

      renderEntityCheckboxes();
      renderPolicies(res.policies || []);
      await loadHistory();
    } catch (e) {
      notice('Lỗi tải dữ liệu dọn MySQL: ' + e.message, true);
    }
  }

  // Load History
  async function loadHistory() {
    try {
      const res = await api('/admin/retention/history');
      const actionLabels = {
        auto_cleanup: 'Cuốn chiếu tự động',
        manual_cleanup: 'Xóa thủ công',
        policy_save: 'Cập nhật cấu hình'
      };
      table('#retention-history-table', res.audit || [], a => [
        date(a.created_at),
        actionLabels[a.action] || a.action,
        a.entity,
        a.record_count.toLocaleString('vi-VN') + ' bản ghi',
        a.triggered_by || 'admin'
      ]);
    } catch (e) {
      notice('Lỗi tải lịch sử: ' + e.message, true);
    }
  }

  $('#refresh-retention-history').addEventListener('click', () => {
    busy($('#refresh-retention-history'), loadHistory);
  });

  // Save Auto Policy
  $('#retention-policy-form').addEventListener('submit', e => {
    e.preventDefault();
    busy($('#save-retention-policy'), async () => {
      const form = e.target;
      const entity = form.elements.entity.value.trim() || null;
      const retentionDays = Number(form.elements.retentionDays.value);
      const scheduleHhmm = form.elements.scheduleHhmm.value.trim();
      const enabled = form.elements.enabled.checked;

      const password = await openPasswordModal('Nhập mật khẩu quản trị để lưu cấu hình xóa cuốn chiếu tự động.');
      await api('/admin/retention/policies', {
        method: 'POST',
        body: JSON.stringify({entity, retentionDays, scheduleHhmm, enabled, password})
      });

      notice('Đã lưu cấu hình xóa cuốn chiếu tự động.');
      await loadRetentionData();
    });
  });

  // Generate Preview
  $('#manual-preview-btn').addEventListener('click', () => {
    busy($('#manual-preview-btn'), async () => {
      const selected = Array.from(document.querySelectorAll('input[name="manualEntities"]:checked')).map(cb => cb.value);
      const dateFrom = $('#manual-date-from').value || null;
      const dateTo = $('#manual-date-to').value || null;

      const res = await api('/admin/retention/preview', {
        method: 'POST',
        body: JSON.stringify({
          entities: selected.length ? selected : null,
          dateFrom,
          dateTo
        })
      });

      currentPreview = {
        previewId: res.previewId,
        eligibleCount: res.eligibleCount,
        skippedCount: res.skippedCount,
        entities: selected.length ? selected : null,
        dateFrom,
        dateTo
      };

      $('#preview-eligible-count').textContent = res.eligibleCount.toLocaleString('vi-VN');
      $('#preview-skipped-count').textContent = res.skippedCount.toLocaleString('vi-VN');
      $('#retention-preview-box').hidden = false;
      $('#retention-progress-box').hidden = true;

      notice(`Xem trước: ${res.eligibleCount} bản ghi đủ điều kiện xóa, ${res.skippedCount} bản ghi bỏ qua.`);
    });
  });

  // Execute Manual Cleanup
  $('#manual-execute-btn').addEventListener('click', () => {
    busy($('#manual-execute-btn'), async () => {
      if (!currentPreview) throw new Error('Vui lòng tạo bản xem trước trước khi xóa.');
      if (currentPreview.eligibleCount === 0) {
        throw new Error('Không có bản ghi nào đủ điều kiện xóa.');
      }

      const password = await openPasswordModal(
        `CẢNH BÁO: Bạn sắp xóa ${currentPreview.eligibleCount.toLocaleString('vi-VN')} bản ghi đủ điều kiện khỏi MySQL. Dữ liệu trên Google Sheets sẽ được giữ nguyên. Nhập mật khẩu quản trị để xác nhận.`
      );

      const jobRes = await api('/admin/retention/jobs', {
        method: 'POST',
        body: JSON.stringify({
          previewId: currentPreview.previewId,
          entities: currentPreview.entities,
          dateFrom: currentPreview.dateFrom,
          dateTo: currentPreview.dateTo,
          password
        })
      });

      activeJobId = jobRes.jobId;
      $('#retention-preview-box').hidden = true;
      $('#retention-progress-box').hidden = false;
      $('#progress-title').textContent = 'Đang dọn dẹp dữ liệu MySQL...';
      $('#progress-status-badge').textContent = 'Đang chạy';
      $('#progress-status-badge').className = 'badge';
      $('#progress-bar-fill').style.width = '0%';
      $('#progress-detail').textContent = 'Đang khởi động lô dọn dẹp...';

      let done = false;
      let totalDeleted = 0;
      let totalSkipped = 0;

      while (!done) {
        const batchRes = await api(`/admin/retention/jobs/${encodeURIComponent(activeJobId)}/batch`, {
          method: 'POST',
          body: JSON.stringify({batchSize: 100})
        });

        done = Boolean(batchRes.done);
        totalDeleted = batchRes.deletedCount ?? totalDeleted;
        totalSkipped = batchRes.skippedCount ?? totalSkipped;

        const totalProcessed = totalDeleted + totalSkipped;
        const totalExpected = Math.max(1, currentPreview.eligibleCount);
        const percent = done ? 100 : Math.min(99, Math.round((totalProcessed / totalExpected) * 100));

        $('#progress-bar-fill').style.width = percent + '%';
        $('#progress-detail').textContent = done
          ? `Hoàn tất: Đã xóa ${totalDeleted.toLocaleString('vi-VN')} bản ghi. Bỏ qua: ${totalSkipped.toLocaleString('vi-VN')} bản ghi.`
          : `Đang xử lý: Đã xóa ${totalDeleted.toLocaleString('vi-VN')} bản ghi (${percent}%)...`;

        if (!done) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      $('#progress-title').textContent = 'Dọn dẹp hoàn tất';
      $('#progress-status-badge').textContent = 'Thành công';
      $('#progress-status-badge').className = 'badge';
      notice(`Hoàn tất dọn dẹp: Đã xóa ${totalDeleted.toLocaleString('vi-VN')} bản ghi khỏi MySQL.`);
      currentPreview = null;
      activeJobId = null;
      await loadHistory();
    });
  });

  return {
    open: loadRetentionData
  };
}

