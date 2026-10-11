import type { ReactNode } from 'react';

type AddDownloadPreviewRowProps = {
  file: string;
  selected: boolean;
  detailsSelected: boolean;
  selectionLabel: string;
  onToggleSelection: () => void;
  onSelectDetails: () => void;
  details: ReactNode;
  mediaControl?: ReactNode;
};

export const AddDownloadPreviewRow = ({
  file,
  selected,
  detailsSelected,
  selectionLabel,
  onToggleSelection,
  onSelectDetails,
  details,
  mediaControl
}: AddDownloadPreviewRowProps) => (
  <div
    role="listitem"
    className={`add-download-preview-row flex flex-col text-xs px-2 py-2 rounded-md group ${
      detailsSelected ? 'is-selected border' : 'border border-transparent'
    }`}
  >
    <div className="flex items-center w-full">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelection}
        aria-label={selectionLabel}
        className="me-2 shrink-0 accent-purple-500"
      />
      <button
        type="button"
        onClick={onSelectDetails}
        aria-pressed={detailsSelected}
        className="flex-1 min-w-0 flex items-center text-start bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
        title={file}
      >
        {details}
      </button>
      {mediaControl}
    </div>
  </div>
);
