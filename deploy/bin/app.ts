import { App, Tags } from 'aws-cdk-lib';
import { PricingMcpStack } from '../lib/stack';

const app = new App();
new PricingMcpStack(app, 'LthAwsPricingMcpStack', {
  env: { account: '695076071513', region: 'eu-south-1' },
});
Tags.of(app).add('Project', 'lth-aws-pricing-calculator-mcp');
Tags.of(app).add('Environment', 'sandbox');
