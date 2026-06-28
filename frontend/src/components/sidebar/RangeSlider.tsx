interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  prefix?: string;
  onChange: (value: number) => void;
}

export default function RangeSlider({ label, value, min, max, step = 1, unit, prefix = '≤', onChange }: Props) {
  return (
    <div className="range-slider">
      <div className="range-slider__header">
        <span className="range-slider__label">{label}</span>
        <span className="range-slider__value">{prefix} {value.toLocaleString()}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
